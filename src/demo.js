// Demo mode — a hands-off "demoscene" showcase camera. No collisions: the camera
// floats freely THROUGH the forest while a set of GSAP timelines drive smooth,
// eased motion so the whole thing feels weightless and composed, like a camera
// operator gliding the scene rather than a physics body bumping through it.
//
// Four independent, looping GSAP behaviours layer up:
//   • heading  — gentle meander: ease to a new forward bearing, glide straight,
//                repeat. This is what makes the path curve in long lazy S's.
//   • speed    — a slow inhale/exhale on forward velocity.
//   • height   — buoyant bob, with an occasional slow crane-up "reveal" shot
//                that rises above the canopy, holds, then settles back down.
//   • gaze     — the look direction pans independently of travel (sweeps to the
//                side, tilts up toward the low sun to catch the godrays), so the
//                camera is always "looking around" while it drifts.
//
// Travel follows `heading`; the gaze adds offsets ON TOP, so you move one way and
// look another — the showcase feel. The horizon is kept dead level (no roll), per
// the standing "zero shake" preference.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { tickGyro, getGyro } from './gyro.js';
import { terrainHeight } from './terrain.js';

const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOOK_PROJ = 12.0;          // how far ahead the look target sits
const HEIGHT_CRUISE = 3.2;       // default eye height above the terrain
const SUN_CONE = 0.85;           // rad — keep travel within ±49° of the sun bearing

export function buildDemo(camera, scene, sunDir) {
  camera.position.set(0, terrainHeight(0, 0) + HEIGHT_CRUISE, 0);

  // Travel always points roughly INTO the sun so the godrays stay in frame (the
  // camera never turns its back on them). forward = (sin h, cos h), so the bearing
  // that faces the sun's azimuth is atan2(sunDir.x, sunDir.z).
  const sd = sunDir || new THREE.Vector3(0.55, 0.27, 0.42);
  const sunYaw = Math.atan2(sd.x, sd.z);

  // Everything the frame loop reads. GSAP owns these values.
  const a = {
    heading:    sunYaw,                         // travel bearing (yaw) — starts at the sun
    speed:      2.6,                            // forward m/s
    height:     HEIGHT_CRUISE,                  // eye height above terrain
    lookYaw:    0,                              // gaze pan, relative to heading
    lookPitch:  0,                              // gaze tilt (pan system)
    cranePitch: 0,                              // gaze tilt added during crane shots
  };

  const tmpLook = new THREE.Vector3();
  const anims = [];                  // every tween/timeline/delayedCall, for dispose
  const track = (t) => { anims.push(t); return t; };
  const rnd = THREE.MathUtils.randFloat;

  // ── Heading: meander, but always within a cone aimed at the sun so the rays
  // stay ahead of us. Each turn eases to a fresh bearing inside ±SUN_CONE. ──────
  function nextTurn() {
    const target = sunYaw + rnd(-SUN_CONE, SUN_CONE);
    track(gsap.to(a, {
      heading: target,
      duration: rnd(7, 13),
      ease: 'sine.inOut',
      onComplete: () => track(gsap.delayedCall(rnd(1.5, 4.5), nextTurn)),
    }));
  }
  nextTurn();

  // ── Speed: slow breath ────────────────────────────────────────────────────
  track(gsap.to(a, { speed: 3.7, duration: 11, ease: 'sine.inOut', repeat: -1, yoyo: true }));

  // ── Height: buoyant bob (always running) ──────────────────────────────────
  track(gsap.to(a, { height: HEIGHT_CRUISE + 1.6, duration: 9, ease: 'power1.inOut', repeat: -1, yoyo: true }));

  // ── Height: occasional crane-up reveal that overrides the bob for one beat ─
  function nextCrane() {
    track(gsap.delayedCall(rnd(24, 40), () => {
      const peak = rnd(6, 9);                                                     // stay under most canopy
      const tl = gsap.timeline({ onComplete: nextCrane });
      tl.to(a, { height: peak,        duration: 7, ease: 'power2.inOut' })
        .to(a, { cranePitch: -0.16,   duration: 7, ease: 'power2.inOut' }, '<')   // look down over the canopy
        .to({}, { duration: 5 })                                                  // hold the overview
        .to(a, { height: HEIGHT_CRUISE, duration: 8, ease: 'power2.inOut' })
        .to(a, { cranePitch: 0,         duration: 8, ease: 'power2.inOut' }, '<');
      track(tl);
    }));
  }
  nextCrane();

  // ── Gaze: sweep side to side, sometimes tilt up to the sun for the godrays ─
  function nextGaze() {
    const yaw = rnd(-0.7, 0.7);
    const pitch = Math.random() < 0.32 ? rnd(0.12, 0.30) : rnd(-0.05, 0.05);
    track(gsap.to(a, {
      lookYaw: yaw, lookPitch: pitch,
      duration: rnd(6, 11),
      ease: 'sine.inOut',
      onComplete: () => track(gsap.delayedCall(rnd(1, 3), nextGaze)),
    }));
  }
  nextGaze();

  function update(dt) {
    // Drift forward along the (eased) heading — no collisions, straight through.
    camera.position.x += Math.sin(a.heading) * a.speed * dt;
    camera.position.z += Math.cos(a.heading) * a.speed * dt;
    camera.position.y = terrainHeight(camera.position.x, camera.position.z) + a.height;

    // Gaze = heading + independent pan/tilt offsets.
    const ly = a.heading + a.lookYaw;
    const lp = a.lookPitch + a.cranePitch;
    tmpLook.set(
      camera.position.x + Math.sin(ly) * LOOK_PROJ,
      camera.position.y + Math.tan(lp) * LOOK_PROJ,
      camera.position.z + Math.cos(ly) * LOOK_PROJ,
    );
    camera.lookAt(tmpLook);

    // Optional gyro peek (mobile), applied after lookAt so it never steers travel.
    tickGyro(dt);
    const g = getGyro();
    if (g.active) {
      camera.rotateOnWorldAxis(_WORLD_UP, g.yaw);
      camera.rotateX(g.pitch);
    }
  }

  function dispose() {
    anims.forEach((t) => t.kill());
  }

  return { controls: null, update, dispose, isAuto: true };
}
