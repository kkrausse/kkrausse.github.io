import{jt as e,s as t}from"./src-hr-tR16w.js";var n=`// Scene pass: every polyline segment is one instance, a quad around the segment in device px; the fragment
// shader computes the distance to the segment (a capsule SDF), so joins come out round and edges anti-aliased.
// Positions come from per-sample affines (data -> device px). For sub-frame accumulation the CPU encodes one
// pass per sub-sample (a time inside the shutter window) with its own x affine and its own block of per-series
// params (\`slotBase\`). \`tau\` blends prev -> cur (the driven path draws cur exactly: tau = 1). The velocity
// target gets (cur - prev) position in device px, prev being the start of the shutter window, for the
// directional blur post-pass.

struct U {
  xCur: vec2f,       // px = x.x * tDays + x.y
  xPrev: vec2f,
  size: vec2f,       // canvas, device px
  tau: f32,
  hw: f32,           // half line width, device px
  glow: f32,
  fill: f32,
  glowR: f32,
  plotBottom: f32,   // device px
  revealL: f32,      // device px
  revealW: f32,
  slotBase: f32,     // first entry of this sub-sample's block in ps
  _b: f32,
};

struct P {
  color: vec4f,
  yCur: vec2f,       // py = y.x * vNorm + y.y
  yPrev: vec2f,
  alpha: f32,
  progress: f32,
  _a: f32,
  _b: f32,
};

@group(0) @binding(0) var<uniform> u: U;
// (t in days from an origin, normalised value, series slot or -1 for a gap/separator, unused)
@group(0) @binding(1) var<storage, read> pts: array<vec4f>;
@group(0) @binding(2) var<storage, read> ps: array<P>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) a: vec2f,
  @location(1) @interpolate(flat) b: vec2f,
  @location(2) vel: vec2f,
  @location(3) @interpolate(flat) slot: u32,
  @location(4) h: f32,
};

struct FOut {
  @location(0) color: vec4f,
  @location(1) vel: vec4f,
};

struct Seg {
  ok: bool,
  a: vec2f,
  b: vec2f,
  va: vec2f,
  vb: vec2f,
  slot: u32,
};

fn toNdc(p: vec2f) -> vec4f {
  return vec4f(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, 0.0, 1.0);
}

fn screen(pt: vec4f, xa: vec2f, ya: vec2f) -> vec2f {
  return vec2f(xa.x * pt.x + xa.y, ya.x * pt.y + ya.y);
}

fn segment(i: u32) -> Seg {
  var s: Seg;
  let pa = pts[i];
  let pb = pts[i + 1u];
  s.ok = pa.z >= 0.0 && pa.z == pb.z;
  if (!s.ok) {
    return s;
  }
  s.slot = u32(u.slotBase) + u32(pa.z);
  let p = ps[s.slot];
  if (p.alpha <= 0.0) {
    s.ok = false;
    return s;
  }
  let xa = mix(u.xPrev, u.xCur, u.tau);
  let ya = mix(p.yPrev, p.yCur, u.tau);
  s.a = screen(pa, xa, ya);
  s.b = screen(pb, xa, ya);
  s.va = screen(pa, u.xCur, p.yCur) - screen(pa, u.xPrev, p.yPrev);
  s.vb = screen(pb, u.xCur, p.yCur) - screen(pb, u.xPrev, p.yPrev);
  return s;
}

fn corner(vi: u32) -> vec2f {
  var c = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  return c[vi];
}

fn quad(vi: u32, ii: u32, r: f32) -> VOut {
  var o: VOut;
  let s = segment(ii);
  if (!s.ok) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  let c = corner(vi);
  let d = s.b - s.a;
  let len = length(d);
  let dir = select(vec2f(1.0, 0.0), d / len, len > 1e-4);
  let n = vec2f(-dir.y, dir.x);
  let along = select(-r, len + r, c.x > 0.5);
  let p = s.a + dir * along + n * (c.y * r);
  o.pos = toNdc(p);
  o.a = s.a;
  o.b = s.b;
  o.vel = mix(s.va, s.vb, c.x);
  o.slot = s.slot;
  o.h = 1.0;
  return o;
}

fn segDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}

/** draw-on: visible left of revealL + progress * revealW, 1px soft edge */
fn reveal(x: f32, slot: u32) -> f32 {
  let pr = ps[slot].progress;
  if (pr >= 1.0) {
    return 1.0;
  }
  return clamp(u.revealL + pr * u.revealW - x + 0.5, 0.0, 1.0);
}

@vertex
fn vsLine(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  return quad(vi, ii, u.hw + 1.0);
}

@fragment
fn fsLine(i: VOut) -> FOut {
  let p = ps[i.slot];
  let d = segDist(i.pos.xy, i.a, i.b);
  let cov = clamp(u.hw + 0.5 - d, 0.0, 1.0) * p.alpha * reveal(i.pos.x, i.slot);
  if (cov <= 0.002) {
    discard;
  }
  var o: FOut;
  o.color = vec4f(p.color.rgb * cov, cov);
  o.vel = vec4f(i.vel, 0.0, 1.0);
  return o;
}

@vertex
fn vsGlow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  return quad(vi, ii, u.glowR * 2.0);
}

// blended with max, so overlapping segment quads do not stack up into beads
@fragment
fn fsGlow(i: VOut) -> FOut {
  let p = ps[i.slot];
  let d = segDist(i.pos.xy, i.a, i.b);
  let g = u.glow * 0.55 * p.alpha * reveal(i.pos.x, i.slot) * exp(-(d * d) / (u.glowR * u.glowR));
  if (g <= 0.002) {
    discard;
  }
  var o: FOut;
  o.color = vec4f(p.color.rgb * g, g);
  o.vel = vec4f(0.0);
  return o;
}

// gradient fill: a trapezoid from each segment down to the plot bottom; neighbours share an edge
@vertex
fn vsFill(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let s = segment(ii);
  if (!s.ok) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  let c = corner(vi);
  let top = mix(s.a, s.b, c.x);
  let p = select(top, vec2f(top.x, u.plotBottom), c.y > 0.0);
  o.pos = toNdc(p);
  o.a = s.a;
  o.b = s.b;
  o.vel = mix(s.va, s.vb, c.x);
  o.slot = s.slot;
  o.h = select(1.0, 0.0, c.y > 0.0);
  return o;
}

@fragment
fn fsFill(i: VOut) -> FOut {
  let p = ps[i.slot];
  let a = u.fill * 0.3 * i.h * i.h * p.alpha * reveal(i.pos.x, i.slot);
  if (a <= 0.002) {
    discard;
  }
  var o: FOut;
  o.color = vec4f(p.color.rgb * a, a);
  o.vel = vec4f(i.vel, 0.0, 1.0);
  return o;
}
`,r=`// Post passes on full-screen triangles:
//   fsCopy     copy a texture (used to add a sub-sample into the accumulation target, blend constant = 1/N)
//   fsTile     max velocity per tile (tile x tile pixels), into a small texture
//   fsResolve  final image to the canvas; with blur on, gathers taps along the max velocity of the 5x5
//              neighbouring tiles (scatter-as-gather: a tap counts if its own motion reaches this pixel)

struct PU {
  size: vec2f,
  tile: f32,
  taps: f32,
  strength: f32,
  blur: f32,
  maxLen: f32,
  _a: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var velT: texture_2d<f32>;
@group(0) @binding(2) var tileT: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> pu: PU;

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment
fn fsCopy(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy), 0);
}

@fragment
fn fsTile(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = i32(pu.tile);
  let base = vec2i(pos.xy) * t;
  let dims = vec2i(textureDimensions(velT));
  var best = vec2f(0.0);
  var bl = 0.0;
  for (var y = 0; y < t; y++) {
    for (var x = 0; x < t; x++) {
      let q = base + vec2i(x, y);
      if (q.x >= dims.x || q.y >= dims.y) {
        continue;
      }
      let v = textureLoad(velT, q, 0).xy;
      let l = dot(v, v);
      if (l > bl) {
        bl = l;
        best = v;
      }
    }
  }
  return vec4f(best, 0.0, 1.0);
}

@fragment
fn fsResolve(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let c0 = textureLoad(src, p, 0);
  if (pu.blur < 0.5) {
    return c0;
  }
  let tc = p / i32(pu.tile);
  let td = vec2i(textureDimensions(tileT)) - vec2i(1);
  var V = vec2f(0.0);
  var vl = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let v = textureLoad(tileT, clamp(tc + vec2i(dx, dy), vec2i(0), td), 0).xy;
      let l = dot(v, v);
      if (l > vl) {
        vl = l;
        V = v;
      }
    }
  }
  V = V * pu.strength;
  let L = length(V);
  if (L < 0.75) {
    return c0;
  }
  if (L > pu.maxLen) {
    V = V * (pu.maxLen / L);
  }
  let v0 = length(textureLoad(velT, p, 0).xy) * pu.strength;
  let n = i32(pu.taps);
  var acc = vec4f(0.0);
  var wsum = 0.0;
  let dims = vec2i(textureDimensions(src)) - vec2i(1);
  for (var i = 0; i < n; i++) {
    let f = (f32(i) + 0.5) / f32(n) - 0.5;
    let off = V * f;
    let q = pos.xy + off;
    let c = textureSampleLevel(src, samp, q / pu.size, 0.0);
    let vs = length(textureLoad(velT, clamp(vec2i(q), vec2i(0), dims), 0).xy) * pu.strength;
    let dist = length(off);
    var w = 0.0;
    if (c.a > 0.01) {
      // a coloured tap smears onto us if its own motion spans this far
      w = select(0.0, 1.0, dist <= vs * 0.5 + 1.0);
    } else {
      // empty tap: counts (as transparent) only when we ourselves are moving that far
      w = select(0.0, 1.0, dist <= v0 * 0.5 + 1.0);
    }
    acc += c * w;
    wsum += w;
  }
  return acc / f32(n) + c0 * ((f32(n) - wsum) / f32(n));
}
`,i=e({createGpuChart:()=>_}),a=864e5,o=32,s=256,c=48,l=32;function u(e){let t=/^#?([0-9a-f]{6})$/i.exec(e.trim());if(!t)return[.4,.4,.4];let n=parseInt(t[1],16);return[(n>>16&255)/255,(n>>8&255)/255,(n&255)/255]}var d=new WeakMap;function f(e){let t=d.get(e);if(t)return t;let n=1/0,r=-1/0;for(let t of e.v)Number.isFinite(t)&&(n=Math.min(n,t),r=Math.max(r,t));return t={rgb:u(e.color),c:Number.isFinite(n)?(n+r)/2:0,s:Number.isFinite(n)&&r>n?(r-n)/2:1},d.set(e,t),t}var p=new WeakMap,m=1,h=e=>{let t=p.get(e);return t||p.set(e,t=m++),t},g=e=>e.plot;async function _(e){e.pushErrorScope(`validation`);let t=e.createShaderModule({code:n,label:`lines`}),i=e.createShaderModule({code:r,label:`post`});for(let e of[t,i]){let t=(await e.getCompilationInfo()).messages.filter(e=>e.type===`error`);if(t.length)throw Error(`WGSL: ${t.map(e=>`${e.lineNum}:${e.linePos} ${e.message}`).join(`; `)}`)}let u=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:`uniform`,hasDynamicOffset:!0,minBindingSize:64}},{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:`read-only-storage`}},{binding:2,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:`read-only-storage`}}]}),d=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`float`}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}},{binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{type:`filtering`}},{binding:4,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`uniform`}}]}),p=e.createPipelineLayout({bindGroupLayouts:[u]}),m=e.createPipelineLayout({bindGroupLayouts:[d]}),_={color:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}},v={color:{srcFactor:`one`,dstFactor:`one`,operation:`max`},alpha:{srcFactor:`one`,dstFactor:`one`,operation:`max`}},y=(n,r,i,a)=>e.createRenderPipeline({layout:p,vertex:{module:t,entryPoint:n},fragment:{module:t,entryPoint:r,targets:[{format:`rgba16float`,blend:i},{format:`rg16float`,writeMask:a}]},primitive:{topology:`triangle-list`}}),b=y(`vsLine`,`fsLine`,_,GPUColorWrite.ALL),x=y(`vsGlow`,`fsGlow`,v,0),S=y(`vsFill`,`fsFill`,_,GPUColorWrite.ALL),C=(t,n,r)=>e.createRenderPipeline({layout:m,vertex:{module:i,entryPoint:`vsFull`},fragment:{module:i,entryPoint:t,targets:[{format:n,blend:r}]},primitive:{topology:`triangle-list`}}),ee=C(`fsCopy`,`rgba16float`,{color:{srcFactor:`constant`,dstFactor:`one`,operation:`add`},alpha:{srcFactor:`constant`,dstFactor:`one`,operation:`add`}}),te=C(`fsTile`,`rgba16float`),w=await e.popErrorScope();if(w)throw Error(`WebGPU pipeline: ${w.message}`);let T=new Map,ne=e=>{let t=T.get(e);return t||T.set(e,t={resolve:C(`fsResolve`,e,_),layer:C(`fsCopy`,e,_)}),t},E=e.createBuffer({size:s*o,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),D=e.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),O=e.createSampler({magFilter:`linear`,minFilter:`linear`}),k=e.createTexture({size:[1,1],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING}),A=null,j=null,M=0,N=null;function re(t){let n=t.map(e=>h(e.src)).join(`,`);if(A&&A.key===n)return A;let r=1/0,i=-1/0,o=0;for(let e of t){let t=e.src.t;t.length&&(r=Math.min(r,t[0]),i=Math.max(i,t[t.length-1])),o+=t.length+1}let s=Number.isFinite(r)?Math.round((r+i)/2/a)*a:0,c=new Float32Array(Math.max(2,o)*4),l=0,u=new Map;t.forEach((e,t)=>{u.set(e.src,t);let{t:n,v:r}=e.src,i=f(e.src);for(let e=0;e<n.length;e++,l+=4){let o=r[e];c[l]=(n[e]-s)/a,c[l+1]=Number.isFinite(o)?(o-i.c)/i.s:0,c[l+2]=Number.isFinite(o)?t:-1}c[l+2]=-1,l+=4}),A?.buf.destroy();let d=e.createBuffer({size:c.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});return e.queue.writeBuffer(d,0,c),A={key:n,buf:d,n:o,tOrigin:s,slots:u},N=null,A}function ie(t){(t>M||!j)&&(M=Math.max(8,t*2),j?.destroy(),j=e.createBuffer({size:M*c,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),N=null),N??=e.createBindGroup({layout:u,entries:[{binding:0,resource:{buffer:E,size:64}},{binding:1,resource:{buffer:A.buf}},{binding:2,resource:{buffer:j}}]})}let P=null;function ae(t,n){if(P&&P.w===t&&P.h===n)return P;for(let e of[`scene`,`accum`,`vel`,`tile`])P?.[e].destroy();let r=(r,i=t,a=n)=>e.createTexture({size:[i,a],format:r,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),i=r(`rgba16float`),a=r(`rgba16float`),o=r(`rg16float`),s=r(`rgba16float`,Math.ceil(t/l),Math.ceil(n/l)),c=(t,n)=>e.createBindGroup({layout:d,entries:[{binding:0,resource:t.createView()},{binding:1,resource:o.createView()},{binding:2,resource:n.createView()},{binding:3,resource:O},{binding:4,resource:{buffer:D}}]});return P={w:t,h:n,scene:i,accum:a,vel:o,tile:s,bgTile:c(i,k),bgScene:c(i,s),bgAccum:c(a,s)},P}let F=t=>e.createBindGroup({layout:d,entries:[{binding:0,resource:t.createView()},{binding:1,resource:k.createView()},{binding:2,resource:k.createView()},{binding:3,resource:O},{binding:4,resource:{buffer:D}}]});function I(e,t,n){let r=g(e);return[r.width*t*a/(e.x1-e.x0),(r.left+r.width*(n-e.x0)/(e.x1-e.x0))*t]}function L(e,t,n){let r=g(e),i=f(t.src),a=r.height*n,o=t.scale;return[-o*i.s*a/(e.y1-e.y0),r.top*n+a-(o*i.c-e.y0)/(e.y1-e.y0)*a]}function R(t){let{style:n,dpr:r}=t,[i,u]=t.origin??[0,0],d=t.outputs??t.sample(t.t1),p=t.target.width,m=t.target.height,h=ae(p,m),_=re(d.series),v=d.series.length,y=Math.max(0,t.t1-t.t0),C=y>0?t.sample(t.t0):d,w=I(d,r,_.tOrigin),T=I(C,r,_.tOrigin),O=0,k=(d.x0-_.tOrigin)/a,A=(d.x1-_.tOrigin)/a;for(let e of[k,A])O=Math.max(O,Math.abs(w[0]*e+w[1]-(T[0]*e+T[1])));let P=new Map(C.series.map(e=>[e.src,e]));for(let e of d.series){if(e.alpha<=0)continue;let t=P.get(e.src);if(!t)continue;let n=L(d,e,r),i=L(C,t,r);for(let e of[-1,1])O=Math.max(O,Math.abs(n[0]*e+n[1]-(i[0]*e+i[1])));(Math.abs(e.alpha-t.alpha)>1e-4||Math.abs(e.reveal-t.reveal)>1e-4)&&(O=Math.max(O,.01))}let R=O>.001,z=Math.min(1,Math.max(0,n.shutter)),B=R&&n.accumulate&&n.samples>1,V=B?Math.max(1,Math.min(o,Math.round(n.samples),Math.ceil(O*z/1.5))):1;V<2&&(B=!1);let H=R&&n.directional;ie(v*V);let U=new Float32Array(s/4*V),W=new Float32Array(M*c/4);for(let e=0;e<V;e++){let a=V===1?t.t1:t.t1-z*y*((V-1-e)/(V-1)),o=e===V-1?d:a===t.t0?C:t.sample(a),l=g(o),h=I(o,r,_.tOrigin),b=s/4*e;U.set([h[0],h[1]-i,T[0],T[1]-i,p,m,1,n.lineWidth*r/2],b),U.set([n.glow,n.fill,Math.max(3,n.lineWidth*3)*r,(l.top+l.height)*r-u],b+8),U.set([l.left*r-i,l.width*r,e*v,0],b+12);let x=new Map(o.series.map(e=>[e.src,e]));d.series.forEach((t,n)=>{let i=x.get(t.src),a=f(t.src),s=(e*v+n)*c/4;if(!i){W.set([...a.rgb,1,0,0,0,0,0,0,0,0],s);return}let l=L(o,i,r),d=P.get(t.src),p=d?L(C,d,r):l;W.set([...a.rgb,1,l[0],l[1]-u,p[0],p[1]-u,Math.max(0,i.alpha),i.reveal,0,0],s)})}e.queue.writeBuffer(E,0,U),e.queue.writeBuffer(j,0,W),e.queue.writeBuffer(D,0,new Float32Array([p,m,l,Math.max(2,Math.round(n.dirSamples)),n.dirStrength,+!!H,64,0]));let G=e.createCommandEncoder(),K=g(d),q=n.lineWidth*r/2+2+(n.glow>0?Math.max(3,n.lineWidth*3)*r*2:0),J={x:Math.max(0,Math.floor(K.left*r-q-i)),y:Math.max(0,Math.floor(K.top*r-q-u))},Y=Math.max(0,Math.min(p,Math.ceil((K.left+K.width)*r+q-i))-J.x),X=Math.max(0,Math.min(m,Math.ceil((K.top+K.height)*r+q-u))-J.y),Z=Math.max(0,_.n-1);for(let e=0;e<V;e++){let t=G.beginRenderPass({colorAttachments:[{view:h.scene.createView(),loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,0]},{view:h.vel.createView(),loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,0]}]});if(Y>0&&X>0&&Z>0&&(t.setScissorRect(J.x,J.y,Y,X),t.setBindGroup(0,N,[e*s]),n.fill>0&&(t.setPipeline(S),t.draw(6,Z)),n.glow>0&&(t.setPipeline(x),t.draw(6,Z)),t.setPipeline(b),t.draw(6,Z)),t.end(),B){let t=G.beginRenderPass({colorAttachments:[{view:h.accum.createView(),loadOp:e===0?`clear`:`load`,storeOp:`store`,clearValue:[0,0,0,0]}]});t.setPipeline(ee),t.setBlendConstant([1/V,1/V,1/V,1/V]),t.setBindGroup(0,h.bgScene),t.draw(3),t.end()}}if(H){let e=G.beginRenderPass({colorAttachments:[{view:h.tile.createView(),loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,0]}]});e.setPipeline(te),e.setBindGroup(0,h.bgTile),e.draw(3),e.end()}let Q=ne(t.target.format),$=G.beginRenderPass({colorAttachments:[{view:t.target.createView(),loadOp:`clear`,storeOp:`store`,clearValue:t.clear??[0,0,0,0]}]});t.under&&($.setPipeline(Q.layer),$.setBindGroup(0,F(t.under)),$.draw(3)),$.setPipeline(Q.resolve),$.setBindGroup(0,B?h.bgAccum:h.bgScene),$.draw(3),t.over&&($.setPipeline(Q.layer),$.setBindGroup(0,F(t.over)),$.draw(3)),$.end(),e.queue.submit([G.finish()]);let oe=e.queue.onSubmittedWorkDone().catch(()=>{});return{outputs:d,samples:V,moving:R||d.moving,done:oe}}return{device:e,draw:R,destroy(){for(let e of[P?.scene,P?.accum,P?.vel,P?.tile,k])e?.destroy();for(let e of[A?.buf,j,E,D])e?.destroy()}}}var v=e({createWebGPURenderer:()=>x,sharedDevice:()=>b}),y=null;function b(){return y??=(async()=>{if(!(`gpu`in navigator)||!navigator.gpu)return null;let e=await navigator.gpu.requestAdapter({powerPreference:`high-performance`});if(!e)return null;let t=await e.requestDevice();return t.lost.then(()=>{y=null}),t})().catch(()=>(y=null,null))}var x=async e=>{let n=await b();if(!n)return null;let r=n,i=e.getContext(`webgpu`);if(!i)return null;let a=navigator.gpu.getPreferredCanvasFormat();i.configure({device:r,format:a,alphaMode:`premultiplied`});let o=await _(r),s=!1,c=t(e,{kind:`webgpu`,resize(){},draw:({sample:e,t0:t,t1:n,dpr:r,tuning:a,outputs:s})=>o.draw({sample:e,t0:t,t1:n,target:i.getCurrentTexture(),dpr:r,style:a,outputs:s}),destroy(){s=!0,i.unconfigure(),o.destroy()}});return r.lost.then(e=>{s||(console.warn(`WebGPU device lost:`,e.message),c.fail(`device lost: ${e.message}`))}),c};export{b as n,i as r,v as t};