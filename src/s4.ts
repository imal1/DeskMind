/**
 * S4 spike — can the docked desktop window get a hardware-accelerated WebGL
 * context, and does its render loop stop when the window is covered?
 *
 * Everything in ADR 0016 rests on this. If the context falls back to SwiftShader
 * the power budget is blown before a single effect is written, and if
 * requestAnimationFrame keeps firing behind other windows we have to detect
 * occlusion ourselves.
 *
 * Deliberately raw WebGL2 with no library: adding OGL before knowing the answer
 * would be building on the assumption under test. Delete this file once the
 * findings are recorded.
 */

import { invoke } from "@tauri-apps/api/core";

type Occlusion = {
  occluded: boolean;
  frontClass: string;
  frontRect: [number, number, number, number];
  workArea: [number, number, number, number];
  why: string;
};

const VERT = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

// Domain-warped value noise. Cheap enough to be honest about the GPU cost of a
// real background effect, expensive enough that software rendering will show.
const FRAG = `#version 300 es
precision highp float;
out vec4 color;
uniform vec2 res;
uniform float time;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 q = vec2(fbm(uv * 3.0 + time * 0.05), fbm(uv * 3.0 - time * 0.04));
  float f = fbm(uv * 4.0 + q * 1.6 + time * 0.02);
  vec3 tint = mix(vec3(0.18, 0.22, 0.38), vec3(0.42, 0.28, 0.46), f);
  color = vec4(tint * (0.35 + f * 0.65), 0.55);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

function rendererName(gl: WebGL2RenderingContext): string {
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (!ext) return gl.getParameter(gl.RENDERER) as string;
  return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
}

export function startS4(): void {
  const stage = document.getElementById("stage")!;

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:absolute;inset:0;z-index:3;pointer-events:none;width:100%;height:100%";
  stage.insertBefore(canvas, stage.firstChild!.nextSibling);

  const readout = document.createElement("div");
  readout.style.cssText =
    "position:absolute;right:16px;top:16px;z-index:40;padding:12px 14px;border-radius:12px;" +
    "background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.14);" +
    "font:11px/1.7 ui-monospace,Consolas,monospace;color:#fff;white-space:pre;pointer-events:none";
  stage.appendChild(readout);

  const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
  if (!gl) {
    readout.textContent = "S4：拿不到 webgl2 上下文";
    return;
  }

  const program = gl.createProgram()!;
  try {
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    }
  } catch (err) {
    readout.textContent = `S4：着色器失败\n${String(err)}`;
    return;
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.useProgram(program);
  const uRes = gl.getUniformLocation(program, "res");
  const uTime = gl.getUniformLocation(program, "time");
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const renderer = rendererName(gl);
  // SwiftShader and "Google Inc." generic strings mean the GPU never got involved.
  const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl!.viewport(0, 0, w, h);
    }
  }

  let frames = 0;
  let started = performance.now();
  // One entry per second. Reading it after uncovering the window shows whether
  // the loop kept running while nobody could see it.
  const history: number[] = [];

  // S4 measured that requestAnimationFrame keeps firing at full rate behind a
  // maximised window, so the backend decides for us whether anyone can see this.
  let hidden = false;
  let running = false;

  function draw(now: number): void {
    if (hidden) {
      running = false;
      return;
    }
    resize();
    gl!.uniform2f(uRes, canvas.width, canvas.height);
    gl!.uniform1f(uTime, now / 1000);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    frames++;
    requestAnimationFrame(draw);
  }

  function resume(): void {
    if (running || hidden) return;
    running = true;
    requestAnimationFrame(draw);
  }
  resume();

  // A second's granularity is plenty: the cost of drawing one extra second of
  // frames is nothing next to the cost of polling the shell continuously.
  let probe: Occlusion | null = null;
  setInterval(() => {
    void invoke<Occlusion>("desktop_occluded").then((result) => {
      probe = result;
      hidden = result.occluded;
      if (!result.occluded) resume();
    });
  }, 1000);

  setInterval(() => {
    const elapsed = (performance.now() - started) / 1000;
    const fps = Math.round(frames / elapsed);
    history.unshift(fps);
    history.length = Math.min(history.length, 24);
    frames = 0;
    started = performance.now();

    readout.textContent = [
      `S4  ${software ? "⚠ 软件渲染" : "硬件加速"}`,
      renderer.slice(0, 46),
      `${canvas.width}×${canvas.height}  dpr ${(window.devicePixelRatio || 1).toFixed(2)}`,
      `fps ${fps}${hidden ? "  (已暂停：被遮挡)" : ""}`,
      "",
      "遮挡判定",
      probe
        ? [
            `  ${probe.why}`,
            `  前台 ${probe.frontClass || "?"}`,
            `  窗口 ${probe.frontRect.join(", ")}`,
            `  工作区 ${probe.workArea.join(", ")}`,
          ].join("\n")
        : "  等待第一次轮询…",
      "",
      "每秒帧数（新→旧）",
      history.join(" "),
    ].join("\n");
  }, 1000);
}
