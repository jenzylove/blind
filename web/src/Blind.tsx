import { useEffect, useRef, useState, type ReactNode } from "react";

export type BlindState = "closed" | "opening" | "open";

/** Only one WebGL blind per page: the first one mounted owns the renderer, every other blind draws the CSS version. */
let glOwner: object | null = null;

/**
 * A venetian blind in front of a lit panel, drawn with three.js.
 * closed:  slats face you, the panel sits in shade (orders sealed, price not yet locked).
 * opening: slats tilt edge on, daylight leaks through (the price is locked, the key is revealed).
 * open:    slats rise and stack under the headrail, leaving a clean lit panel (settled).
 * Falls back to a plain CSS panel when WebGL is missing, `flat` is set, or another blind already owns WebGL.
 * The renderer draws only while the slats move, and waits while the blind is off screen or the tab is hidden.
 */
export default function Blind({ state, children, className = "", label, flat = false }: { state: BlindState; children: ReactNode; className?: string; label?: string; flat?: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLDivElement>(null);
  const target = useRef(state);
  const kick = useRef<() => void>(() => undefined);
  const [gl, setGl] = useState(false);
  target.current = state;

  useEffect(() => { kick.current(); }, [state]);

  useEffect(() => {
    if (flat || glOwner) return;
    const me = {};
    glOwner = me;
    const el = stage.current!, w = win.current!;
    let disposed = false;
    let cleanup = () => undefined as void;
    (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch { return; }
      if (disposed) return;
      let r: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      } catch { return; }
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      r.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.domElement.className = "blind-gl";
      el.appendChild(r.domElement);
      setGl(true);

      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
      let W = 6, H = 4, band = 0.6;
      const N = 13;
      const slats: InstanceType<typeof THREE.Mesh>[] = [];
      const geos: { dispose(): void }[] = [];
      const mat = new THREE.MeshPhysicalMaterial({ color: 0x2a2b30, metalness: 0.55, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.35 });
      const slatGeo = (sw: number, d: number) => {
        // gently curved slat, like real aluminium
        const g = new THREE.BoxGeometry(sw, d, 0.018, 40, 8, 1);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setZ(i, p.getZ(i) + (1 - (2 * y / d) ** 2) * 0.035); }
        g.computeVertexNormals();
        return g;
      };
      const railGeo = new THREE.BoxGeometry(1, 1, 1);
      const railMat = new THREE.MeshPhysicalMaterial({ color: 0x1b1c20, metalness: 0.6, roughness: 0.3, clearcoat: 0.8 });
      const rail = new THREE.Mesh(railGeo, railMat);
      scene.add(rail);
      const strGeo = new THREE.CylinderGeometry(0.006, 0.006, 1, 6);
      const strMat = new THREE.MeshStandardMaterial({ color: 0x8a8270, roughness: 0.9 });
      const strings = [0, 1].map(() => { const s = new THREE.Mesh(strGeo, strMat); scene.add(s); return s; });
      const cordGeo = new THREE.CylinderGeometry(0.009, 0.009, 1, 8);
      const cordMat = new THREE.MeshStandardMaterial({ color: 0x6d6658, roughness: 0.8 });
      const cord = new THREE.Mesh(cordGeo, cordMat); scene.add(cord);
      const tasGeo = new THREE.CylinderGeometry(0.03, 0.045, 0.16, 12);
      const tasMat = new THREE.MeshPhysicalMaterial({ color: 0x26272b, metalness: 0.5, roughness: 0.35 });
      const tassel = new THREE.Mesh(tasGeo, tasMat); scene.add(tassel);
      scene.add(new THREE.HemisphereLight(0x6b6a70, 0x0a0a0c, 0.55));
      const back = new THREE.DirectionalLight(0xffe2a0, 5.5); back.position.set(-0.6, 1.6, -3); scene.add(back); // daylight from the window
      const key = new THREE.DirectionalLight(0xdfe3ff, 0.55); key.position.set(-2, 2.5, 4); scene.add(key);
      const spec = new THREE.PointLight(0xfff1c8, 6, 12, 1.6); spec.position.set(1.8, 1.2, 2.2); scene.add(spec);

      function layout() {
        const cw = el.clientWidth, ch = w.offsetTop + w.offsetHeight;
        if (!cw || !ch) return;
        r.setSize(cw, ch);
        cam.aspect = cw / ch;
        H = 4; W = H * w.offsetWidth / w.offsetHeight; band = H * w.offsetTop / w.offsetHeight;
        const tot = H + band;
        cam.position.set(0, band / 2, (tot / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
        cam.lookAt(0, band / 2, 0);
        cam.updateProjectionMatrix();
        for (const s of slats) scene.remove(s);
        slats.length = 0;
        for (const g of geos) g.dispose();
        geos.length = 0;
        const g = slatGeo(W * 0.985, (H / N) * 1.12); geos.push(g);
        for (let i = 0; i < N; i++) { const m = new THREE.Mesh(g, mat); scene.add(m); slats.push(m); }
        rail.scale.set(W * 1.01, 0.16, 0.22);
        rail.position.set(0, H / 2 + band - 0.12, 0);
        draw();
      }

      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const cl = (x: number) => Math.min(1, Math.max(0, x));
      // raw progress of the two stages; tilt first, then lift. Lowering runs in reverse.
      let tiltP = 0, liftP = 0;
      const goalTilt = () => (target.current === "closed" ? 0 : 1);
      const goalLift = () => (target.current === "open" ? 1 : 0);
      if (reduced) { tiltP = goalTilt(); liftP = goalLift(); }
      // CSS variables are written only when their rounded value changes, so the page restyles a few times per move, not every frame.
      let vo = "", vg = "", vb = "";

      function draw() {
        if (!slats.length) return;
        const tilt = ease(tiltP), lift = ease(liftP);
        const gap = H / N, top = H / 2;
        for (let i = 0; i < N; i++) {
          const s = slats[i];
          const yDown = top - gap * (i + 0.5), yUp = top + band - 0.24 - i * 0.024; // stacked under the headrail
          const li = cl(lift * 1.25 - (N - 1 - i) * 0.02); // bottom slat leaves first
          s.position.y = yDown + (yUp - yDown) * ease(li);
          s.rotation.x = -0.12 + (-Math.PI / 2 + 0.12) * tilt; // closed: faces you; open: edge on
        }
        const bottom = slats[N - 1].position.y;
        const rb = top + band - 0.2;
        const len = rb - bottom + 0.05;
        for (let k = 0; k < 2; k++) { const s = strings[k]; s.scale.y = len; s.position.set((k ? 1 : -1) * W * 0.3, rb - len / 2, 0.03); }
        const cl2 = 1.4 + lift * 1.1;
        cord.scale.y = cl2; cord.position.set(W / 2 - 0.12, rb - cl2 / 2, 0.08); tassel.position.set(W / 2 - 0.12, rb - cl2 - 0.06, 0.08);
        const light = Math.max(tilt * 0.55, lift);
        const o = cl(tilt * 0.25 + lift).toFixed(2), g = (0.03 + light * 0.09).toFixed(3), b = (0.55 + 0.45 * light).toFixed(2);
        if (o !== vo) { vo = o; el.style.setProperty("--o", o); }
        if (g !== vg) { vg = g; el.style.setProperty("--g", g); }
        if (b !== vb) { vb = b; el.style.setProperty("--b", b); }
        back.intensity = 3 + light * 4;
        r.render(scene, cam);
      }

      let raf = 0, last = 0, onScreen = true;
      const active = () => onScreen && !document.hidden;
      function step(ms: number) {
        if (!active()) { raf = 0; last = 0; return; } // picks up from here when visible again
        const dt = last ? Math.min(0.05, (ms - last) / 1000) : 0.016; last = ms;
        const gt = goalTilt(), gl = goalLift();
        // up: tilt then lift. down: lower then flatten.
        if (liftP > gl) liftP = Math.max(gl, liftP - dt / 1.4);
        else if (tiltP < gt) tiltP = Math.min(gt, tiltP + dt / 1.3);
        else if (liftP < gl) liftP = Math.min(gl, liftP + dt / 1.5);
        else if (tiltP > gt) tiltP = Math.max(gt, tiltP - dt / 1.1);
        draw();
        if (tiltP !== gt || liftP !== gl) raf = requestAnimationFrame(step); else { raf = 0; last = 0; }
      }
      kick.current = () => {
        if (reduced) { tiltP = goalTilt(); liftP = goalLift(); draw(); return; }
        if (!raf && active()) { last = 0; raf = requestAnimationFrame(step); }
      };
      const io = new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; if (onScreen) kick.current(); });
      io.observe(el);
      const onVis = () => { if (!document.hidden) kick.current(); };
      document.addEventListener("visibilitychange", onVis);
      const ro = new ResizeObserver(() => layout());
      ro.observe(el);
      layout();
      kick.current();
      cleanup = () => {
        cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        for (const g of geos) g.dispose();
        for (const x of [railGeo, strGeo, cordGeo, tasGeo, mat, railMat, strMat, cordMat, tasMat]) x.dispose();
        r.dispose(); r.forceContextLoss(); r.domElement.remove();
        setGl(false);
        kick.current = () => undefined;
      };
    })();
    return () => { disposed = true; cleanup(); if (glOwner === me) glOwner = null; };
  }, [flat]);

  return (
    <div ref={stage} className={`blind ${state} ${flat ? "flat" : ""} ${gl ? "gl" : ""} ${className}`} data-state={state} aria-label={label} role={label ? "group" : undefined}>
      <div className="blind-glow" aria-hidden />
      <div ref={win} className="blind-win">
        <div className="blind-in">{children}</div>
        <div className="blind-shade" aria-hidden />
      </div>
    </div>
  );
}
