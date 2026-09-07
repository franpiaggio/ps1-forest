// Touch controls for manual exploring on phones:
//   • a virtual joystick (nipplejs) on the bottom-left → movement,
//   • drag anywhere on the right → look (yaw / pitch),
//   • a toggleable gyroscope that ADDS a look offset on top of the drag,
//   • an on-screen Exit button — the only way back to the menu.
//
// Camera collisions reuse the same cylinder solver as the desktop player.

import * as THREE from 'three';
import nipplejs from 'nipplejs';
import { resolveCollisions } from './collision.js';
import { enableGyro, disableGyro, tickGyro, getGyro, recalibrate } from './gyro.js';
import { terrainHeight } from './terrain.js';

const EYE_HEIGHT   = 1.7;
const PLAYER_RADIUS = 0.4;
const WALK_SPEED   = 3.2;          // m/s — brisk walk through the (now realistic) forest
const ACCEL        = 12;
const FRICTION     = 9;
const LOOK_SENS    = 0.0042;       // rad per px dragged
const MAX_PITCH    = Math.PI / 2 - 0.08;

// ── Shared on-screen UI ──────────────────────────────────────────────────────
function styleBtn(el, accent) {
  el.style.cssText =
    'pointer-events:auto;border:none;border-radius:10px;padding:12px 16px;' +
    'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:600;' +
    'letter-spacing:0.06em;cursor:pointer;backdrop-filter:blur(4px);' +
    (accent
      ? 'background:rgba(255,212,130,0.92);color:#1a1308;'
      : 'background:rgba(28,35,42,0.82);color:#cfd5dc;border:1px solid rgba(255,255,255,0.12);');
}

// Top bar: Exit (left) + Gyro toggle (right). Returns { root, setGyroOn, dispose }.
function buildHud({ onExit, onToggleGyro, gyroOn }) {
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:40;display:flex;justify-content:space-between;' +
    'padding:10px 12px;pointer-events:none;';

  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = '✕ Exit';
  styleBtn(exit, false);
  exit.addEventListener('click', () => onExit?.());

  const gyro = document.createElement('button');
  gyro.type = 'button';
  styleBtn(gyro, false);
  let on = !!gyroOn;
  const paint = () => { gyro.textContent = on ? '🧭 Gyro: ON' : '🧭 Gyro: OFF'; gyro.style.opacity = on ? '1' : '0.6'; };
  paint();
  gyro.addEventListener('click', () => { on = !on; paint(); onToggleGyro?.(on); });

  root.append(exit, gyro);
  document.body.appendChild(root);

  return {
    root,
    setGyroOn(v) { on = v; paint(); },
    isOn: () => on,
    dispose() { root.remove(); },
  };
}

// ── Auto mode: just the HUD (Exit + gyro toggle), no joystick ────────────────
export function buildAutoMobileHud({ onExit, gyroOn = true }) {
  const hud = buildHud({
    onExit,
    gyroOn,
    onToggleGyro: (v) => { if (v) enableGyro(); else disableGyro(); },
  });
  return { dispose: hud.dispose };
}

// ── Manual walk: joystick + drag-look + gyro + HUD ───────────────────────────
export function buildMobilePlayer(camera, scene, { onExit } = {}) {
  camera.position.set(0, terrainHeight(0, 0) + EYE_HEIGHT, 0);
  let yaw = Math.PI, pitch = 0;          // start facing -Z like the other modes
  const velocity = new THREE.Vector3();
  const move = { x: 0, y: 0 };           // joystick: x=right, y=forward
  let gyroOn = false;

  // ── HUD (gyro starts OFF; tapping it requests permission on a user gesture) ─
  const hud = buildHud({
    onExit,
    gyroOn: false,
    onToggleGyro: (v) => {
      gyroOn = v;
      if (v) enableGyro().then((ok) => { if (!ok) { gyroOn = false; hud.setGyroOn(false); } });
      else disableGyro();
    },
  });

  // ── Joystick zone (bottom-left) ─────────────────────────────────────────────
  const joyZone = document.createElement('div');
  joyZone.style.cssText =
    'position:fixed;left:0;bottom:0;width:45vw;height:55vh;z-index:35;touch-action:none;';
  document.body.appendChild(joyZone);

  const joystick = nipplejs.create({
    zone: joyZone,
    mode: 'static',
    position: { left: '90px', bottom: '90px' },
    color: 'rgba(255,255,255,0.7)',
    size: 110,
    restOpacity: 0.55,
  });
  // nipplejs 1.0.4: the handler gets ONE arg (an InternalEvent); the joystick
  // data lives on `evt.data` — NOT a second `(evt, data)` parameter. Reading the
  // old second arg left `move` permanently 0, so the joystick only ever looked.
  joystick.on('move', (evt) => {
    const d = evt?.data;
    if (!d || !d.angle) return;
    // force-based so a full push always gives full speed.
    const f = Math.min(1, d.force ?? 0);
    move.x = Math.cos(d.angle.radian) * f;   // right
    move.y = Math.sin(d.angle.radian) * f;   // forward (π/2 = up = forward)
  });
  joystick.on('end', () => { move.x = 0; move.y = 0; });

  // ── Look zone (right side, drag = yaw/pitch) ────────────────────────────────
  const lookZone = document.createElement('div');
  lookZone.style.cssText =
    'position:fixed;right:0;top:0;width:55vw;height:100vh;z-index:34;touch-action:none;';
  document.body.appendChild(lookZone);

  let lookId = null, lastX = 0, lastY = 0;
  const onStart = (e) => {
    if (lookId !== null) return;
    const t = e.changedTouches[0];
    lookId = t.identifier; lastX = t.clientX; lastY = t.clientY;
  };
  const onMove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      yaw   -= (t.clientX - lastX) * LOOK_SENS;
      pitch -= (t.clientY - lastY) * LOOK_SENS;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
      lastX = t.clientX; lastY = t.clientY;
      e.preventDefault();
    }
  };
  const onEnd = (e) => {
    for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null;
  };
  lookZone.addEventListener('touchstart', onStart, { passive: true });
  lookZone.addEventListener('touchmove', onMove, { passive: false });
  lookZone.addEventListener('touchend', onEnd, { passive: true });
  lookZone.addEventListener('touchcancel', onEnd, { passive: true });

  // ── Per-frame update ────────────────────────────────────────────────────────
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function update(dt, world) {
    // Look = drag heading + (optional) gyro offset.
    tickGyro(dt);
    const g = getGyro();
    const gy = (gyroOn && g.active) ? g.yaw : 0;
    const gp = (gyroOn && g.active) ? g.pitch : 0;
    euler.set(Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + gp)), yaw + gy, 0);
    camera.quaternion.setFromEuler(euler);

    // Movement on the XZ plane, relative to where we're looking.
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    right.crossVectors(fwd, camera.up).normalize();

    const targetVx = (fwd.x * move.y + right.x * move.x) * WALK_SPEED;
    const targetVz = (fwd.z * move.y + right.z * move.x) * WALK_SPEED;
    const moving = (move.x * move.x + move.y * move.y) > 1e-4;
    const k = 1 - Math.exp(-(moving ? ACCEL : FRICTION) * dt);
    velocity.x += (targetVx - velocity.x) * k;
    velocity.z += (targetVz - velocity.z) * k;

    const nextX = camera.position.x + velocity.x * dt;
    const nextZ = camera.position.z + velocity.z * dt;
    const trees = world.getNearbyTrees(nextX, nextZ, PLAYER_RADIUS + 1);
    const { pos } = resolveCollisions(nextX, nextZ, PLAYER_RADIUS, trees);
    camera.position.x = pos[0];
    camera.position.z = pos[1];
    camera.position.y = terrainHeight(camera.position.x, camera.position.z) + EYE_HEIGHT;
  }

  function dispose() {
    joystick.destroy();
    joyZone.remove();
    lookZone.remove();
    hud.dispose();
    disableGyro();
  }

  // recalibrate gyro reference whenever it's (re)enabled — handled in enableGyro
  void recalibrate;

  return { update, dispose, isAuto: false };
}
