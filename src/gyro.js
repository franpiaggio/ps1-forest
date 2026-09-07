// Device orientation → look-around offset (mobile only).
//
// Reads the standard `deviceorientation` event, builds the canonical
// three.js device-to-world quaternion (same math as the deprecated
// DeviceOrientationControls), then expresses *delta from a reference
// pose* as (yaw, pitch) offsets in radians. Roll is dropped — we never
// tilt the horizon. The explorer applies these offsets *after* it sets
// its own camera direction, so the path of travel is unaffected.
//
// iOS 13+ requires `DeviceOrientationEvent.requestPermission()` to be
// called from a user gesture. `enableGyro()` handles that — call it from
// the click handler that switches to auto mode.

import * as THREE from 'three';

const _zee = new THREE.Vector3(0, 0, 1);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _euler = new THREE.Euler();

const _refInv     = new THREE.Quaternion();
const _curr       = new THREE.Quaternion();
const _delta      = new THREE.Quaternion();
const _deltaEuler = new THREE.Euler();

let hasRef       = false;
let listening    = false;
let active       = false;
let resetPending = false;

let yawRaw = 0,    pitchRaw = 0;
let yawSmooth = 0, pitchSmooth = 0;

const PITCH_MAX = Math.PI / 3;   // ±60° — keeps the sky / ground from inverting

function buildCurrent(alpha, beta, gamma, orient) {
  // alpha = compass yaw, beta = front-back tilt, gamma = left-right tilt,
  // orient = screen rotation. Same composition order as Three.js's
  // (now deprecated) DeviceOrientationControls.
  _euler.set(beta, alpha, -gamma, 'YXZ');
  _curr.setFromEuler(_euler);
  _curr.multiply(_q1);
  _curr.multiply(_q0.setFromAxisAngle(_zee, -orient));
}

function onOrient(e) {
  if (e.alpha == null) return;
  const a  = THREE.MathUtils.degToRad(e.alpha);
  const b  = THREE.MathUtils.degToRad(e.beta);
  const g  = THREE.MathUtils.degToRad(e.gamma);
  const so = THREE.MathUtils.degToRad(
    screen.orientation?.angle ?? window.orientation ?? 0
  );
  buildCurrent(a, b, g, so);

  // First reading (or after recalibrate()): freeze a reference pose.
  if (resetPending || !hasRef) {
    _refInv.copy(_curr).invert();
    hasRef = true;
    resetPending = false;
  }

  // Delta from reference, decomposed in YXZ → yaw = .y, pitch = .x.
  _delta.multiplyQuaternions(_refInv, _curr);
  _deltaEuler.setFromQuaternion(_delta, 'YXZ');
  yawRaw   = _deltaEuler.y;
  pitchRaw = THREE.MathUtils.clamp(_deltaEuler.x, -PITCH_MAX, PITCH_MAX);
}

export async function enableGyro() {
  if (typeof window === 'undefined') return false;
  if (typeof window.DeviceOrientationEvent === 'undefined') return false;

  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') return false;
    } catch (_) {
      return false;
    }
  }

  if (!listening) {
    window.addEventListener('deviceorientation', onOrient);
    listening = true;
  }
  active = true;
  resetPending = true;  // re-zero on every re-enable
  return true;
}

export function disableGyro() {
  active = false;
}

export function recalibrate() {
  resetPending = true;
}

// Call each frame. Smooths raw values toward zero when inactive so the
// view eases back to neutral instead of snapping.
export function tickGyro(dt) {
  const target_y = active ? yawRaw   : 0;
  const target_p = active ? pitchRaw : 0;
  const k = 1 - Math.exp(-8 * dt);
  yawSmooth   += (target_y - yawSmooth)   * k;
  pitchSmooth += (target_p - pitchSmooth) * k;
}

export function getGyro() {
  return { yaw: yawSmooth, pitch: pitchSmooth, active };
}

export function isMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // Tablets / hybrid: coarse pointer + touch event support.
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  return coarse && 'ontouchstart' in window;
}
