'use client';

import { useEffect, useRef } from 'react';

// The moving "liquid" behind the OTP reference (compassionate-celery-632226.framer.app), redone as
// one small WebGL fragment shader: domain-warped noise in violet on near-black. No dependency.
// Without WebGL the canvas stays empty and the CSS layers above it carry the look. With reduced
// motion it draws a single still frame.

const VERTEX_SHADER = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.y * 1.4;
  float t = u_time * 0.06;
  vec2 q = vec2(fbm(uv + vec2(0.0, t)), fbm(uv + vec2(5.2, -t)));
  vec2 r = vec2(fbm(uv + 3.0 * q + vec2(1.7, 9.2) + t), fbm(uv + 3.0 * q + vec2(8.3, 2.8) - t));
  float f = fbm(uv + 3.0 * r);

  vec3 ink = vec3(0.024, 0.024, 0.031);    // #060606
  vec3 deep = vec3(0.16, 0.12, 0.36);
  vec3 violet = vec3(0.608, 0.549, 1.0);   // #9B8CFF
  vec3 color = mix(ink, deep, smoothstep(0.2, 0.8, f));
  color = mix(color, violet, smoothstep(0.62, 1.0, f) * 0.55 * length(r));
  gl_FragColor = vec4(color, 1.0);
}
`;

// A still frame from partway into the motion looks better than t = 0.
const STILL_TIME_S = 8;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

export function LiquidBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl', { antialias: false, depth: false });
    if (!canvas || !gl) return;
    const program = createProgram(gl);
    if (!program) return;
    gl.useProgram(program);

    // One triangle that covers the whole screen.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, 'u_resolution');
    const time = gl.getUniformLocation(program, 'u_time');

    const stillOnly = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const startedAt = performance.now();
    let frame = 0;

    const draw = (now: number) => {
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, stillOnly ? STILL_TIME_S : (now - startedAt) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      draw(now);
      frame = requestAnimationFrame(loop);
    };

    // Half resolution: the image is soft anyway, and it keeps phones cool.
    const resize = () => {
      const scale = 0.5 * Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (stillOnly) draw(performance.now());
    };
    // Don't spend the battery on a tab nobody is looking at.
    const onVisibilityChange = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden && !stillOnly) frame = requestAnimationFrame(loop);
    };

    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!stillOnly) frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" />;
}
