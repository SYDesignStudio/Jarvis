import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, extend, useFrame, useThree, type ThreeElement, type ThreeEvent } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'

// <line> in JSX is the SVG element, so three's Line is registered under its own name.
extend({ Line_: THREE.Line })
declare module '@react-three/fiber' {
  interface ThreeElements {
    line_: ThreeElement<typeof THREE.Line>
  }
}
const cssVar = (name: string, value: string) => ({ [name]: value }) as React.CSSProperties
import { useStore } from '../store'
import {
  colourOf,
  fetchEmails,
  fetchGalaxy,
  fetchSatellites,
  orbitOf,
  pickWanted,
  resolveFocus,
  type Focus,
  type Galaxy as GalaxyData,
  type Satellite,
  type Star,
} from '../lib/galaxy'

/**
 * The memory galaxy.
 *
 * Every job the practice has done is a star. The spiral arms are councils —
 * the way an architect's world is really organised — and a star's distance
 * along its arm is its place in time, so the newest work sits at the bright
 * tips. Pick a star and its memory comes into orbit: notes on the inner ring,
 * current drawings on the middle one, emails on the outer. When JARVIS cites
 * a source, the camera flies to it, the rest of the galaxy dims to embers, and
 * a beam runs from the star to the exact note, drawing or email he used.
 *
 * Drawn with points and a small shader rather than meshes: a hundred and
 * forty stars and their satellites are one draw call each, which keeps the
 * reactor scene beside it running at full rate. The hand controller works
 * here unchanged, because OrbitControls listens to the same pointer events.
 */

const REDUCED = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const BG = '#020a0c'

const VERT = /* glsl */ `
attribute float size;
attribute float alpha;
attribute float ring;
attribute vec3 tint;
varying float vAlpha;
varying float vRing;
varying vec3 vTint;
void main() {
  vAlpha = alpha; vRing = ring; vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (280.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`
const FRAG = /* glsl */ `
varying float vAlpha;
varying float vRing;
varying vec3 vTint;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float glow = pow(smoothstep(0.5, 0.0, d), 1.35);
  float core = smoothstep(0.17, 0.0, d);
  float ringA = smoothstep(0.045, 0.0, abs(d - 0.3)) + 0.12 * smoothstep(0.5, 0.0, d);
  float a = mix(glow * 0.8 + core, ringA, vRing) * vAlpha;
  if (a < 0.012) discard;
  gl_FragColor = vec4(vTint + vec3(core * 0.55), a);
}`

function makeMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}

function pointsGeometry(n: number) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1))
  g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n), 1))
  g.setAttribute('ring', new THREE.BufferAttribute(new Float32Array(n), 1))
  return g
}

const setColour = (attr: THREE.BufferAttribute, i: number, hex: string, k = 1) => {
  const c = new THREE.Color(hex)
  attr.setXYZ(i, c.r * k, c.g * k, c.b * k)
}

/* ------------------------------------------------------------------ stars */

function Stars({
  galaxy,
  selected,
  hovered,
  onHover,
  onSelect,
}: {
  galaxy: GalaxyData
  selected: string | null
  hovered: number | null
  onHover: (i: number | null) => void
  onSelect: (i: number) => void
}) {
  const index = useMemo(() => new Map(galaxy.stars.map((s, i) => [s.id, i])), [galaxy])
  const geo = useMemo(() => {
    const g = pointsGeometry(galaxy.stars.length)
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const tint = g.getAttribute('tint') as THREE.BufferAttribute
    const size = g.getAttribute('size') as THREE.BufferAttribute
    const alpha = g.getAttribute('alpha') as THREE.BufferAttribute
    const ring = g.getAttribute('ring') as THREE.BufferAttribute
    galaxy.stars.forEach((s, i) => {
      pos.setXYZ(i, s.x, s.y, s.z)
      setColour(tint, i, colourOf(galaxy, s), s.recent ? 1 : 0.62)
      size.setX(i, s.kind === 'lead' ? 3.2 : s.recent ? 3.8 : 2.5)
      alpha.setX(i, s.recent ? 1 : 0.6)
      ring.setX(i, s.kind === 'lead' ? 1 : 0)
    })
    return g
  }, [galaxy])
  const mat = useMemo(makeMaterial, [])
  useEffect(() => () => void (geo.dispose(), mat.dispose()), [geo, mat])

  // Dim everything but the chosen star, and light the hovered one — eased, per frame.
  useFrame((_, dt) => {
    const alpha = geo.getAttribute('alpha') as THREE.BufferAttribute
    const sel = selected ? (index.get(selected) ?? -1) : -1
    const k = REDUCED ? 1 : Math.min(1, dt * 7)
    let changed = false
    for (let i = 0; i < galaxy.stars.length; i++) {
      const base = galaxy.stars[i].recent ? 1 : 0.6
      const target = i === sel || i === hovered ? 1 : sel >= 0 ? base * 0.22 : base
      const cur = alpha.getX(i)
      const next = cur + (target - cur) * k
      if (Math.abs(next - cur) > 0.0015) {
        alpha.setX(i, next)
        changed = true
      }
    }
    if (changed) alpha.needsUpdate = true
  })

  return (
    <points
      geometry={geo}
      material={mat}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation()
        onHover(e.index ?? null)
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation()
        if (e.index != null) onSelect(e.index)
      }}
    />
  )
}

/* -------------------------------------------------------------------- dust */

/**
 * A faint field of dust strewn along the arms, so the spiral reads as a body
 * rather than a scatter of points. Four motes per star, placed by the same
 * stable hash the layout uses, tinted by the arm at a fraction of its light.
 */
function Dust({ galaxy }: { galaxy: GalaxyData }) {
  const geo = useMemo(() => {
    const per = 4
    const g = pointsGeometry(galaxy.stars.length * per)
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const tint = g.getAttribute('tint') as THREE.BufferAttribute
    const size = g.getAttribute('size') as THREE.BufferAttribute
    const alpha = g.getAttribute('alpha') as THREE.BufferAttribute
    let h = 7
    const rnd = () => ((h = (h * 48271) % 2147483647) / 2147483647) - 0.5
    galaxy.stars.forEach((s, i) => {
      const c = colourOf(galaxy, s)
      for (let k = 0; k < per; k++) {
        const j = i * per + k
        pos.setXYZ(j, s.x + rnd() * 5, s.y + rnd() * 1.4, s.z + rnd() * 5)
        setColour(tint, j, c, s.halo ? 0.25 : 0.45)
        size.setX(j, 1.6 + Math.abs(rnd()) * 2.2)
        alpha.setX(j, 0.22)
      }
    })
    return g
  }, [galaxy])
  const mat = useMemo(makeMaterial, [])
  useEffect(() => () => void (geo.dispose(), mat.dispose()), [geo, mat])
  return <points geometry={geo} material={mat} raycast={() => null} />
}

/* -------------------------------------------------------------- satellites */

type Placed = { sat: Satellite; i: number; n: number }

function Orbit({
  star,
  colour,
  sats,
  focusId,
  onPick,
}: {
  star: Star
  colour: string
  sats: Satellite[]
  focusId: string | null
  onPick: (s: Satellite) => void
}) {
  const placed = useMemo<Placed[]>(() => {
    const byType = new Map<string, Satellite[]>()
    for (const s of sats) (byType.get(s.type) ?? byType.set(s.type, []).get(s.type)!).push(s)
    return sats.map((sat) => {
      const group = byType.get(sat.type)!
      return { sat, i: group.indexOf(sat), n: group.length }
    })
  }, [sats])
  const geo = useMemo(() => {
    const g = pointsGeometry(placed.length)
    const tint = g.getAttribute('tint') as THREE.BufferAttribute
    const size = g.getAttribute('size') as THREE.BufferAttribute
    const alpha = g.getAttribute('alpha') as THREE.BufferAttribute
    placed.forEach((p, i) => {
      setColour(tint, i, p.sat.type === 'note' ? '#f4f3f0' : p.sat.type === 'file' ? colour : '#7aa7ff', 0.95)
      size.setX(i, 1.05)
      alpha.setX(i, 0.9)
    })
    return g
  }, [placed, colour])
  const lines = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(placed.length * 6), 3))
    return g
  }, [placed])
  const beam = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
    return g
  }, [])
  const mat = useMemo(makeMaterial, [])
  useEffect(() => () => void (geo.dispose(), lines.dispose(), beam.dispose(), mat.dispose()), [geo, lines, beam, mat])
  const [hover, setHover] = useState<number | null>(null)
  const clock = useRef(0)
  const anchor = useRef<THREE.Group>(null)
  const focusIdx = focusId ? placed.findIndex((p) => p.sat.id === focusId) : -1

  useFrame((_, dt) => {
    if (!REDUCED) clock.current += dt
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const size = geo.getAttribute('size') as THREE.BufferAttribute
    const alpha = geo.getAttribute('alpha') as THREE.BufferAttribute
    const lp = lines.getAttribute('position') as THREE.BufferAttribute
    placed.forEach((p, i) => {
      const o = orbitOf(p.sat.type)
      const ang = (p.i / Math.max(1, p.n)) * Math.PI * 2 + clock.current * o.speed
      const x = star.x + o.r * Math.cos(ang)
      const y = star.y + o.r * Math.sin(ang) * Math.sin(o.tilt)
      const z = star.z + o.r * Math.sin(ang) * Math.cos(o.tilt)
      pos.setXYZ(i, x, y, z)
      lp.setXYZ(i * 2, star.x, star.y, star.z)
      lp.setXYZ(i * 2 + 1, x, y, z)
      const lit = i === focusIdx || i === hover
      size.setX(i, lit ? 1.8 + (i === focusIdx ? 0.35 * Math.sin(clock.current * 4) : 0) : 1.05)
      alpha.setX(i, focusIdx >= 0 && !lit ? 0.45 : 0.9)
      if (i === focusIdx) {
        const bp = beam.getAttribute('position') as THREE.BufferAttribute
        bp.setXYZ(0, star.x, star.y, star.z)
        bp.setXYZ(1, x, y, z)
        bp.needsUpdate = true
        anchor.current?.position.set(x, y, z)
      }
    })
    pos.needsUpdate = size.needsUpdate = alpha.needsUpdate = lp.needsUpdate = true
  })

  const labelled = hover != null ? placed[hover] : focusIdx >= 0 ? placed[focusIdx] : null
  return (
    <>
      <points
        geometry={geo}
        material={mat}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          setHover(e.index ?? null)
        }}
        onPointerOut={() => setHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          if (e.index != null) onPick(placed[e.index].sat)
        }}
      />
      <lineSegments geometry={lines}>
        <lineBasicMaterial color={colour} transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} />
      </lineSegments>
      {focusIdx >= 0 && (
        <line_ geometry={beam}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} />
        </line_>
      )}
      <group ref={anchor}>
        {labelled && (
          <Html center distanceFactor={14} style={{ transform: 'translateY(-18px)' }}>
            <div className="gx-label">
              <b>{labelled.sat.date || labelled.sat.type}</b> {labelled.sat.sub}
              <br />
              {labelled.sat.label.slice(0, 90)}
            </div>
          </Html>
        )}
      </group>
    </>
  )
}
/* ------------------------------------------------------------------ camera */

type Goal = { pos: THREE.Vector3; target: THREE.Vector3 }

function Flight({ goal, controls }: { goal: Goal | null; controls: React.RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree()
  const live = useRef<Goal | null>(null)
  useEffect(() => {
    live.current = goal
    const c = controls.current
    if (goal && REDUCED && c) {
      camera.position.copy(goal.pos)
      c.target.copy(goal.target)
      c.update()
      live.current = null
    }
  }, [goal, camera, controls])
  useFrame((_, dt) => {
    const g = live.current
    const c = controls.current
    if (!g || !c) return
    const k = 1 - Math.pow(0.018, dt)
    camera.position.lerp(g.pos, k)
    c.target.lerp(g.target, k)
    c.update()
    if (camera.position.distanceTo(g.pos) < 0.03) live.current = null
  })
  return null
}

function Picking() {
  const raycaster = useThree((s) => s.raycaster)
  useEffect(() => {
    raycaster.params.Points = { threshold: 0.9 }
  }, [raycaster])
  return null
}

/* ------------------------------------------------------------------- scene */

function Scene({
  galaxy,
  selected,
  sats,
  focusSat,
  goal,
  onSelect,
  onPick,
  onHover,
  hovered,
  spin,
}: {
  galaxy: GalaxyData
  selected: Star | null
  sats: Satellite[]
  focusSat: string | null
  goal: Goal | null
  onSelect: (i: number) => void
  onPick: (s: Satellite) => void
  onHover: (i: number | null) => void
  hovered: number | null
  spin: React.RefObject<THREE.Group | null>
}) {
  const controls = useRef<OrbitControlsImpl | null>(null)
  useFrame((_, dt) => {
    if (spin.current && !selected && !REDUCED) spin.current.rotation.y += dt * 0.035
  })
  const tips = useMemo(
    () =>
      galaxy.arms.map((arm, k) => {
        const last = galaxy.stars.filter((s) => s.armIndex === k).sort((a, b) => b.t - a.t)[0]
        if (!last) return null
        const len = Math.hypot(last.x, last.z) || 1
        return { arm, x: last.x * (1 + 3.2 / len), y: last.y + 1.2, z: last.z * (1 + 3.2 / len) }
      }),
    [galaxy],
  )
  const hov = hovered != null ? galaxy.stars[hovered] : null
  return (
    <>
      <color attach="background" args={[BG]} />
      <Picking />
      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.07} enablePan={false} minDistance={3} maxDistance={130} rotateSpeed={0.55} />
      <Flight goal={goal} controls={controls} />
      <group ref={spin}>
        <Dust galaxy={galaxy} />
        <Stars galaxy={galaxy} selected={selected?.id ?? null} hovered={hovered} onHover={onHover} onSelect={onSelect} />
        {/* The practice at the core. */}
        <Html position={[0, 0, 0]} center className="gx-core" style={{ pointerEvents: 'none' }}>
          <div className="gx-arm" style={{ color: '#9fb3ba', opacity: selected ? 0.25 : 0.7 }}>
            SY Design Studio<small>{galaxy.totals.jobs} jobs</small>
          </div>
        </Html>
        {tips.map(
          (t) =>
            t && (
              <Html key={t.arm.name} position={[t.x, t.y, t.z]} center style={{ pointerEvents: 'none' }}>
                <div className="gx-arm" style={{ color: t.arm.colour, opacity: selected ? 0.3 : 0.85 }}>
                  {t.arm.name}
                  <small>{t.arm.count} jobs</small>
                </div>
              </Html>
            ),
        )}
        {hov && (!selected || hov.id !== selected.id) && (
          <Html position={[hov.x, hov.y, hov.z]} center style={{ pointerEvents: 'none', transform: 'translateY(-16px)' }}>
            <div className="gx-label">
              <b>{hov.number || 'enquiry'}</b> {hov.address}
              {hov.halo ? <span className="gx-dim"> · {hov.arm}</span> : null}
            </div>
          </Html>
        )}
        {selected && <Orbit star={selected} colour={colourOf(galaxy, selected)} sats={sats} focusId={focusSat} onPick={onPick} />}
      </group>
    </>
  )
}

/* -------------------------------------------------------------------- view */

export const Galaxy = memo(function Galaxy({ focus }: { focus?: string }) {
  const [galaxy, galaxy_] = useState<GalaxyData | null>(null)
  const [error, error_] = useState<string | null>(null)
  const [selected, selected_] = useState<Star | null>(null)
  const [hovered, hovered_] = useState<number | null>(null)
  const [sats, sats_] = useState<Satellite[]>([])
  const [emailsState, emails_] = useState<'idle' | 'loading' | 'done' | 'failed'>('idle')
  const [focusSat, focusSat_] = useState<string | null>(null)
  const [picked, picked_] = useState<Satellite | null>(null)
  const [goal, goal_] = useState<Goal | null>(null)
  const spin = useRef<THREE.Group | null>(null)
  const want = useRef<Focus['want'] | null>(null)
  const cache = useRef(new Map<string, Satellite[]>())
  const pushBlade = useStore((s) => s.pushBlade)

  useEffect(() => {
    let dead = false
    fetchGalaxy()
      .then((g) => !dead && galaxy_(g))
      .catch((e: Error) => !dead && error_(e.message))
    return () => {
      dead = true
    }
  }, [])

  const flyTo = useCallback((star: Star) => {
    const local = new THREE.Vector3(star.x, star.y, star.z)
    const world = spin.current ? spin.current.localToWorld(local.clone()) : local
    const out = new THREE.Vector3(world.x, 0, world.z)
    if (out.lengthSq() < 0.01) out.set(1, 0, 0)
    out.normalize()
    goal_({ pos: world.clone().add(out.multiplyScalar(7.5)).add(new THREE.Vector3(0, 3.2, 0)), target: world })
  }, [])

  const choose = useCallback(
    (star: Star) => {
      selected_(star)
      picked_(null)
      focusSat_(null)
      flyTo(star)
      const known = cache.current.get(star.id)
      if (known) {
        sats_(known)
        emails_('done')
        return
      }
      sats_([])
      emails_('loading')
      void fetchSatellites(star.id).then((list) => {
        sats_(list)
        cache.current.set(star.id, list)
        return fetchEmails(star.id)
          .then((mails) => {
            const all = [...list, ...mails]
            cache.current.set(star.id, all)
            sats_(all)
            emails_('done')
          })
          .catch(() => emails_('failed'))
      })
    },
    [flyTo],
  )

  // Light the satellite JARVIS cited, once it is in orbit.
  useEffect(() => {
    if (!want.current || !sats.length) return
    const hit = pickWanted(want.current, sats)
    if (hit) {
      focusSat_(hit.id)
      picked_(hit)
      want.current = null
    } else if (emailsState === 'done' || emailsState === 'failed') want.current = null
  }, [sats, emailsState])

  // A focus from JARVIS: "1110 email:26/0772".
  useEffect(() => {
    if (!galaxy) return
    const f = resolveFocus(focus, galaxy)
    if (!f) return
    const star = galaxy.stars.find((s) => s.id === f.starId)
    if (!star) return
    want.current = f.want ?? null
    choose(star)
  }, [galaxy, focus, choose])

  const onSelect = useCallback((i: number) => galaxy && choose(galaxy.stars[i]), [galaxy, choose])
  const onPick = useCallback(
    (s: Satellite) => {
      picked_(s)
      focusSat_(s.id)
    },
    [],
  )
  const open = (s: Satellite) => {
    if (s.type !== 'file' || !s.path) return
    pushBlade({ id: `doc-${s.id}`, title: s.label.replace(/\.pdf$/i, '').slice(0, 40).toUpperCase(), kind: 'document', url: s.path, size: 'full', hold: 'sticky', mode: 'reader' })
  }
  const clear = () => {
    selected_(null)
    picked_(null)
    focusSat_(null)
    sats_([])
    goal_(null)
  }

  if (error) return <p className="bl-note">The galaxy could not be built: {error}</p>
  if (!galaxy) return <div className="bl-galaxy"><p className="gx-note">Charting {'…'}</p></div>

  const byType = (t: Satellite['type']) => sats.filter((s) => s.type === t)
  return (
    <div className="bl-galaxy">
      <Canvas camera={{ position: [0, 70, 58], fov: 48, near: 0.1, far: 600 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} onPointerMissed={clear}>
        <Scene galaxy={galaxy} selected={selected} sats={sats} focusSat={focusSat} goal={goal} onSelect={onSelect} onPick={onPick} onHover={hovered_} hovered={hovered} spin={spin} />
      </Canvas>

      {selected && (
        <aside className="gx-card" style={cssVar('--accent', colourOf(galaxy, selected))}>
          <h3>{selected.number ? `${selected.number}` : 'ENQUIRY'}</h3>
          <div className="gx-sub">
            {selected.address}
            <br />
            {selected.arm}
            {selected.touched ? ` · last touched ${new Date(selected.touched).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
          </div>
          {picked && (
            <div className="gx-picked">
              <span className="gx-date">{picked.date}</span>
              {picked.sub}
              <div>{picked.label}</div>
              {picked.type === 'file' && (
                <button type="button" className="gx-open" onClick={() => open(picked)}>
                  Open drawing
                </button>
              )}
            </div>
          )}
          {(['note', 'file', 'email'] as const).map((t) => {
            const list = byType(t)
            const title = t === 'note' ? 'Notes' : t === 'file' ? 'Current drawings & reports' : 'Emails'
            if (!list.length && !(t === 'email' && emailsState === 'loading') && !(t !== 'email' && emailsState === 'loading' && !sats.length)) return null
            return (
              <div key={t}>
                <h4>
                  {title}
                  {t === 'email' && emailsState === 'loading' ? ' · searching' : ''}
                </h4>
                <ul>
                  {list.map((s) => (
                    <li key={s.id} className={s.id === focusSat ? 'on' : ''}>
                      <button type="button" onClick={() => onPick(s)} onDoubleClick={() => open(s)}>
                        <span className="gx-date">{s.date}</span>
                        {s.label.slice(0, 80)}
                        <span className="gx-src">{s.sub}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </aside>
      )}

      <div className="gx-legend">
        {galaxy.arms.map((a) => (
          <span key={a.name} style={cssVar('--c', a.colour)}>
            {a.name}
          </span>
        ))}
        <span style={cssVar('--c', '#9fb3ba')}>{(galaxy.halo ?? []).length} other councils</span>
        <span className="gx-ring">enquiry</span>
      </div>
      <div className="gx-hint">drag to turn · scroll to zoom · click a star · double-click a drawing to open · K to close</div>
    </div>
  )
})
