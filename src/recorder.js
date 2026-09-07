// In-page video recorder for social clips. Captures the WebGL canvas + the live
// audio (ambient loop + music, routed through one AudioContext so the file has
// exactly what you hear) into a single MediaStream, records it with MediaRecorder
// and downloads a .webm.
//
// Triggered by putting `record` in the URL hash, e.g.
//   …/13/#record                       → 1080×1080, 15 s, R every 1.5 s, music @50s
//   …/13/#record?w=1080&h=1920&secs=30 → 9:16, 30 s
// Params: w, h, secs, rint (R interval s), music (music start s), fps.

// createMediaElementSource can only be called ONCE per <audio> element — cache it.
const SRC_CACHE = new WeakMap();

export function isRecordMode() {
  return /\brecord\b/.test(location.hash + ' ' + location.search);
}

export function getRecordOpts() {
  const q = location.hash.includes('?') ? location.hash.split('?')[1] : location.search.replace(/^\?/, '');
  const p = new URLSearchParams(q);
  const num = (k, d) => { const v = parseFloat(p.get(k)); return Number.isFinite(v) ? v : d; };
  return {
    w:          num('w', 1080),
    h:          num('h', 1080),
    secs:       num('secs', 15),
    rint:       num('rint', 1.5),
    roffset:    num('roffset', 0.5),   // delay the R schedule so cuts land on the beat
    auto:       p.get('auto') === '1', // auto-fire R on a timer; default OFF (you press R)
    native:     p.get('native') === '1', // record at the real window resolution (ignore w/h)
    musicStart: num('music', 50),
    fps:        num('fps', 60),
    mbps:       num('mbps', 24),        // video bitrate in Mbps
  };
}

function pickMime() {
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return cands.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || 'video/webm';
}

// Records `canvas` + `audioElements` for `durationMs`, then auto-downloads a webm.
// Returns a controller with stop(). Calls onStop(blob) when finished.
export function recordCanvasWithAudio({ canvas, fps = 60, audioElements = [], durationMs, onStop, mbps = 24 }) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const actx = new Ctx();
  const dest = actx.createMediaStreamDestination();
  const sources = [];
  for (const el of audioElements) {
    let src = SRC_CACHE.get(el);
    if (!src) { src = actx.createMediaElementSource(el); SRC_CACHE.set(el, src); }
    src.connect(dest);
    src.connect(actx.destination);          // keep it audible while recording
    sources.push(src);
  }

  const stream = canvas.captureStream(fps);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.round(mbps * 1e6) });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forest-demo-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    try { actx.close(); } catch (_) { /* ignore */ }
    onStop?.(blob);
  };

  const begin = () => {
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, durationMs);
  };
  (actx.state === 'suspended' ? actx.resume() : Promise.resolve()).then(begin, begin);

  // IMPORTANT: keep actx/dest/sources/rec/stream referenced. A
  // MediaStreamAudioDestinationNode with no JS reference gets garbage-collected,
  // which silences the recorded audio after a few seconds. The caller MUST hold
  // on to this returned object for the whole recording.
  return { stop: () => { if (rec.state !== 'inactive') rec.stop(); }, _keepAlive: { actx, dest, sources, rec, stream } };
}
