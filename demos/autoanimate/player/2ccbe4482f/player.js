// The page side of the browser player: fetches the plan, plays its audio,
// owns the clock (slaved to the voice while it sounds), and asks the wasm
// renderer for the frame at the current time on every animation frame.
import init, { Film } from "./pkg/psychopomp_web.js";

const query = new URLSearchParams(location.search);
const number = (name, fallback) => {
  const value = Number(query.get(name));
  return query.has(name) && Number.isFinite(value) ? value : fallback;
};
const SAMPLES = Math.max(1, Math.round(number("samples", 4)));
const FPS = number("fps", 60) === 30 ? 30 : 60;
const THEME = query.get("theme") ?? "neutral";
/// The film: a directory (default `film/`), or a `.film` file (one zip; see
/// `openFilm`). A page may name its film in `<meta name="autoanimate-film">`
/// instead of the query, as the shelf's per-film pages do.
const FILM = (
  query.get("film") ??
  document.querySelector('meta[name="autoanimate-film"]')?.getAttribute("content") ??
  "film"
).replace(/\/+$/, "");
const FILM_FILE = /\.film$/i.test(FILM);
/// The entries of a `.film`, by path inside it, as object URLs; null for a directory.
let packed = null;
/// The plan, when it is not the film directory's plan.json: the studio page
/// hands over one it has just compiled, as a blob URL.
let PLAN = query.get("plan") ?? `${FILM}/plan.json`;
/// The manifest of a film in several plans: the film directory's film.json,
/// or one somewhere else (the studio's, whose chapters name plans by URL).
/// A `plan=` alone means that one plan and no manifest. In a `.film` it is
/// the entry `chapters.json` (its `film.json` is the container's manifest).
let MANIFEST = query.get("manifest") ?? (query.has("plan") ? null : `${FILM}/film.json`);
/// A media path is relative to the film directory unless it is already a URL.
const mediaUrl = (path) =>
  /^(blob:|data:|https?:|\/)/.test(path) ? path : packed ? packed.get(path) ?? `missing:${path}` : `${FILM}/${path}`;
/// The `.film` format majors this player reads.
const FILM_FORMAT = 1;
const DEBUG = query.get("debug") === "1";
/// Seconds the back and forward buttons move.
const SKIP = 10;
/// The speed button climbs in these steps to the top rate, then wraps to 1.
const RATE_STEP = 0.25;
const RATE_TOP = 3.5;
const RATE_KEY = "autoanimate.speed";
/// A clip longer than this (or the plan's `script` clip) is the voice: it
/// plays through an <audio> element, which keeps its pitch at any speed.
/// Shorter clips are sound effects, decoded and scheduled on the AudioContext.
const VOICE_SECONDS = 30;
/// How long the picture waits for a voice that is buffering before going on
/// without it. Bounded so that audio which never arrives cannot hang the film.
const STALL_SECONDS = 6;

const $ = (id) => document.getElementById(id);
const canvas = $("stage");
const player = $("player");
const message = (text) => ($("message").textContent = text);
const validRate = (rate) => Number.isFinite(rate) && rate >= 0.25 && rate <= 4;
const storedRate = () => {
  try {
    return Number(localStorage.getItem(RATE_KEY) ?? NaN);
  } catch {
    return NaN;
  }
};
const storeRate = (rate) => {
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // Private windows and blocked storage: the speed just is not remembered.
  }
};
/// The cues of a WebVTT file as `{ start, end, text }` in film seconds, in order.
const parseVtt = (vtt) => {
  const seconds = (stamp) => stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const cues = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const [start, end] = lines[timing].split("-->").map((stamp) => seconds(stamp.trim().split(/\s+/)[0]));
    const text = lines.slice(timing + 1).join(" ").trim();
    if (text && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text });
  }
  return cues;
};
const minutes = (time) => {
  const whole = Math.max(0, Math.floor(time));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/// A `.film`: one zip holding a whole film. The first entry, `film.json`, is
/// its manifest (`format`, slug, title, credit, `entries` with a role each);
/// the rest are the film directory's files under their own paths. JSON and
/// captions are deflated; audio is stored, so it is sliced out as it is.
/// Fetched whole; returns the manifest and a Map of path to object URL.
async function openFilm(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer);
  // The end-of-central-directory record: last, after up to 64 KB of comment.
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 22 - 65535) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error(`${url}: not a .film (no zip directory)`);
  const names = new TextDecoder();
  const entries = new Map();
  let at = view.getUint32(end + 16, true);
  for (let index = view.getUint16(end + 10, true); index > 0; index--) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`${url}: damaged zip directory`);
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.set(name, { method, data: bytes.subarray(start, start + size) });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  const read = async (name) => {
    const { method, data } = entries.get(name);
    if (method === 0) return data;
    if (method !== 8) throw new Error(`${url}: ${name} is packed with zip method ${method}, which this player cannot read`);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  if (!entries.has("film.json")) throw new Error(`${url}: not a .film (no film.json)`);
  const manifest = JSON.parse(new TextDecoder().decode(await read("film.json")));
  const major = Math.floor(Number(manifest.format));
  if (major !== FILM_FORMAT) {
    throw new Error(`${url} is a .film of format ${manifest.format}; this player reads format ${FILM_FORMAT}. A newer player is needed.`);
  }
  const types = new Map((manifest.entries ?? []).map((entry) => [entry.path, entry.type]));
  const files = new Map();
  for (const name of entries.keys()) {
    if (name === "film.json" || name.endsWith("/")) continue;
    const type = types.get(name) ?? "application/octet-stream";
    files.set(name, URL.createObjectURL(new Blob([await read(name)], { type })));
  }
  return { manifest, files };
}

async function main() {
  if (!navigator.gpu) {
    message("This page needs WebGPU, which this browser does not offer.");
    return;
  }
  if (!(await navigator.gpu.requestAdapter())) {
    message("This page needs WebGPU, and this browser has no usable GPU adapter for it.");
    return;
  }
  // A film is one plan (`plan.json`, or `plan=`), or several played end to
  // end: a manifest (the directory's `film.json`, or `manifest=`) whose
  // `chapters` name a plan each and the film second it starts at, and whose
  // `media` is the audio that runs under them all (the voice). Long films are
  // cut up this way because a plan's cost per frame grows with everything it
  // declares, on screen or not.
  const text = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.text();
  };
  const wasmReady = init();
  if (FILM_FILE) {
    message("Loading…");
    const opened = await openFilm(FILM);
    packed = opened.files;
    if (!query.has("plan")) PLAN = packed.get("plan.json") ?? PLAN;
    if (!query.has("manifest")) MANIFEST = query.has("plan") ? null : packed.get("chapters.json") ?? null;
    if (opened.manifest.title) document.title = opened.manifest.title;
    message("");
  }
  const [manifest, wasm] = await Promise.all([
    MANIFEST
      ? fetch(MANIFEST)
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
      : null,
    wasmReady,
  ]);
  let film;
  let media;
  const loadStarted = performance.now();
  if (manifest?.chapters?.length) {
    const texts = await Promise.all(manifest.chapters.map((chapter) => text(mediaUrl(chapter.plan))));
    const starts = manifest.chapters.map((chapter) => chapter.start);
    film = await Film.load_chapters(canvas, texts, Float64Array.from(starts), THEME);
    // A chapter's sounds are timed from its own start.
    media = [...(manifest.media ?? [])];
    texts.forEach((planText, index) => {
      const shift = Math.round(starts[index] * 1e9);
      for (const item of JSON.parse(planText).media ?? []) {
        media.push({
          ...item,
          timelineStartNanos: item.timelineStartNanos + shift,
          timelineEndNanos: item.timelineEndNanos + shift,
        });
      }
    });
  } else {
    const planText = await text(PLAN);
    film = await Film.load(canvas, planText, THEME);
    media = JSON.parse(planText).media ?? [];
  }
  const duration = film.duration;
  // Fetching the plan or plans, parsing them and preparing the first frame's resources.
  const loadMs = performance.now() - loadStarted;

  // Scene time. Paused: `at`. Playing: `rate` scene seconds per wall second
  // since `since`, pulled toward the voice so picture follows sound without
  // inheriting its jitter. The wall clock alone carries the silent lead and
  // tail, where no voice sounds.
  const queryRate = number("speed", NaN);
  const clock = {
    playing: false,
    at: Math.max(0, Math.min(number("t", 0), duration)),
    since: 0,
    rate: validRate(queryRate) ? queryRate : validRate(storedRate()) ? storedRate() : 1,
  };
  const now = () =>
    clock.playing ? clock.at + ((performance.now() - clock.since) / 1000) * clock.rate : clock.at;
  const rebase = (time) => {
    clock.at = Math.max(0, Math.min(time, duration));
    clock.since = performance.now();
  };

  let dirty = true;

  // The transcript strip: the film's captions.vtt, if it has one, shown a cue
  // at a time under the picture. A cue stays until the next one starts, or a
  // little past its end before a pause.
  let cues = [];
  let cueShown = "";
  const subtitle = $("subtitle");
  const cueAt = (time) => {
    let low = 0;
    let high = cues.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (cues[middle].start <= time) low = middle;
      else high = middle - 1;
    }
    const cue = cues[low];
    return cue && cue.start <= time && time < cue.end + 0.7 ? cue.text : "";
  };
  if (!query.has("plan") && (!packed || packed.has("captions.vtt"))) {
    fetch(mediaUrl("captions.vtt"))
      .then((response) => (response.ok ? response.text() : ""))
      .then((vtt) => {
        cues = parseVtt(vtt);
        subtitle.hidden = cues.length === 0;
        dirty = true;
      })
      .catch(() => {});
  }
  // The scene time of the last tick, where the picture holds while the voice buffers.
  let shown = clock.at;
  let stalled = 0;

  const pause = () => {
    rebase(now());
    clock.playing = false;
    audio.stop();
    player.classList.remove("playing");
    $("play").setAttribute("aria-label", "Play");
    wake();
  };
  // Nothing here may wait: phone browsers only let audio start inside the
  // tap that asked for it, so the voice element is played before returning.
  const play = () => {
    if (clock.at >= duration - 0.01) rebase(0);
    message("");
    audio.start(clock.at, clock.rate);
    rebase(clock.at);
    shown = clock.at;
    stalled = 0;
    clock.playing = true;
    player.classList.add("playing");
    $("play").setAttribute("aria-label", "Pause");
    wake();
  };
  const toggle = () => (clock.playing ? pause() : play());
  const seek = (time) => {
    rebase(time);
    shown = clock.at;
    stalled = 0;
    if (clock.playing) audio.seek(clock.at, clock.rate);
    dirty = true;
  };
  const skip = (seconds) => seek(now() + seconds);
  const showRate = () => ($("speed").textContent = `${Number(clock.rate.toFixed(2))}×`);
  const setRate = (rate) => {
    rebase(now());
    clock.rate = rate;
    audio.setRate(rate);
    showRate();
  };
  const nextRate = () => {
    const up = Math.floor(clock.rate / RATE_STEP + 1e-6) * RATE_STEP + RATE_STEP;
    setRate(up > RATE_TOP + 1e-6 ? 1 : up);
    storeRate(clock.rate);
  };

  const audio = createAudio(media, {
    failed: (text) => message(text),
    // The browser refused to start the voice outside a tap: stop, so the next
    // tap on play starts it from inside one.
    blocked: () => {
      pause();
      message("Tap play to start the sound.");
    },
  });

  // Controls. In landscape they lie over the film and fade while it plays.
  let idleTimer = 0;
  let scrubbing = false;
  const overlaid = matchMedia("(orientation: landscape)");
  function wake() {
    player.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (clock.playing && !scrubbing) player.classList.add("idle");
    }, 2600);
  }
  const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement;
  const requestFullscreen = player.requestFullscreen ?? player.webkitRequestFullscreen;
  const toggleFullscreen = () => {
    if (fullscreenElement()) {
      (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
      return;
    }
    Promise.resolve(requestFullscreen.call(player))
      // Phones that can lock orientation turn the film on its side.
      .then(() => screen.orientation?.lock?.("landscape"))
      .catch(() => {});
  };
  // iPhone Safari has no element fullscreen, so it gets no button.
  if (requestFullscreen && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled)) {
    $("fullscreen").hidden = false;
    $("fullscreen").onclick = toggleFullscreen;
  }

  $("play").onclick = toggle;
  $("back").onclick = () => skip(-SKIP);
  $("forward").onclick = () => skip(SKIP);
  $("speed").onclick = nextRate;
  $("scrub").oninput = () => seek(Number($("scrub").value) * duration);
  $("scrub").addEventListener("pointerdown", () => (scrubbing = true));
  for (const type of ["pointerup", "pointercancel", "change"]) {
    $("scrub").addEventListener(type, () => {
      scrubbing = false;
      wake();
    });
  }
  for (const type of ["pointerdown", "click", "input", "focusin"]) $("controls").addEventListener(type, wake);
  player.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") wake();
  });
  // A tap on the film: with a finger and overlaid controls it shows or hides
  // them; otherwise (mouse, or portrait where they are always there) it plays
  // or pauses.
  let touched = false;
  player.addEventListener("pointerdown", (event) => (touched = event.pointerType !== "mouse"));
  player.addEventListener("click", (event) => {
    if ($("controls").contains(event.target) || $("play").disabled) return;
    if (!(touched && overlaid.matches)) toggle();
    else if (player.classList.contains("idle") || !clock.playing) wake();
    else player.classList.add("idle");
  });
  addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const action = {
      Space: toggle,
      ArrowLeft: () => skip(-SKIP),
      ArrowRight: () => skip(SKIP),
      KeyF: () => !$("fullscreen").hidden && toggleFullscreen(),
    }[event.code];
    if (!action) return;
    // Space on a focused button would also click it.
    event.preventDefault();
    if (event.target instanceof HTMLElement) event.target.blur();
    action();
    wake();
  });
  for (const id of ["play", "back", "forward", "scrub"]) $(id).disabled = false;
  showRate();
  message("");

  let lastRender = -Infinity;
  let lastTick = performance.now();
  const stats = { frames: 0, drawn: 0, cpu: 0, since: performance.now(), text: "" };
  const frame = (stamp) => {
    requestAnimationFrame(frame);
    const tick = performance.now();
    const elapsed = (tick - lastTick) / 1000;
    lastTick = tick;
    if (clock.playing) {
      const voice = audio.follow(now(), clock.rate);
      if (voice === "waiting" && stalled < STALL_SECONDS) {
        // The voice is due but not sounding yet (starting, seeking, or
        // buffering): hold the picture where it is.
        if (stalled === 0) audio.restage();
        stalled += elapsed;
        rebase(shown);
        if (stalled > 0.6) message("buffering audio…");
      } else if (voice !== null && voice !== "waiting") {
        const error = voice.time - now();
        if (Math.abs(error) > 0.1 * Math.max(1, clock.rate)) {
          // A large gap is a stall the picture did not wait for: jump.
          rebase(now() + error);
          audio.restage();
        } else {
          // Coming out of a hold, take the voice's time as it is; otherwise ease.
          rebase(now() + error * (stalled > 0 ? 1 : 0.05));
        }
        if (stalled > 0.6) message("");
        stalled = 0;
      }
      shown = now();
      if (shown >= duration) {
        pause();
        rebase(duration);
        dirty = true;
      }
    }
    // A 60 Hz display shows a 30 fps film on every other refresh.
    if (!(clock.playing || dirty) || stamp - lastRender < 1000 / FPS - 3) return;
    lastRender = stamp;
    dirty = false;
    const time = now();
    const started = performance.now();
    try {
      stats.drawn += film.render(time, SAMPLES, FPS);
    } catch (error) {
      pause();
      message(`render: ${error.message ?? error}`);
      return;
    }
    stats.cpu += performance.now() - started;
    stats.frames += 1;
    if (stamp - stats.since >= 1000) {
      const seconds = (stamp - stats.since) / 1000;
      stats.text =
        `${(stats.frames / seconds).toFixed(1)} fps (target ${FPS}) · ` +
        `${SAMPLES} samples (${(stats.drawn / stats.frames).toFixed(1)} drawn) · ` +
        `${(stats.cpu / stats.frames).toFixed(1)} ms cpu`;
      window.__film.stats = {
        fps: stats.frames / seconds,
        drawn: stats.drawn / stats.frames,
        cpuMs: stats.cpu / stats.frames,
      };
      Object.assign(stats, { frames: 0, drawn: 0, cpu: 0, since: stamp });
    }
    if (DEBUG) $("readout").textContent = `${time.toFixed(2)} s · ${stats.text}`;
    if (cues.length) {
      const text = cueAt(time);
      if (text !== cueShown) subtitle.firstElementChild.textContent = cueShown = text;
    }
    $("clock").textContent = `${minutes(time)} / ${minutes(duration)}`;
    if (!scrubbing) $("scrub").value = String(time / duration);
    $("scrub").style.setProperty("--played", `${((time / duration) * 100).toFixed(2)}%`);
  };

  // For checking from a console or a driver, not part of the page.
  window.__film = {
    film,
    duration,
    stats: null,
    loadMs,
    /// Bytes of the renderer's wasm memory, which only grows.
    wasmBytes: () => wasm.memory.buffer.byteLength,
    play,
    pause,
    seek,
    skip,
    setRate,
    nextRate,
    time: now,
    rate: () => clock.rate,
    playing: () => clock.playing,
    /// The voice elements as the browser reports them.
    voices: () => audio.voices(),
    /// The frame at `time` as a PNG data URL. A WebGPU canvas only holds its
    /// pixels until the task that drew them ends, so draw and read together.
    still(time, samples = 1) {
      film.render(time, samples, FPS);
      return canvas.toDataURL("image/png");
    },
    /// Mean render() milliseconds over `frames` frames from `time`, without
    /// waiting on the display: the CPU cost of a frame.
    bench(time, samples, frames = 120) {
      const started = performance.now();
      for (let index = 0; index < frames; index += 1) film.render(time + index / FPS, samples, FPS);
      return (performance.now() - started) / frames;
    },
  };
  requestAnimationFrame(frame);
}

/// Every audio placement in the plan, played at its place on the timeline at
/// any speed.
///
/// The voice plays through <audio> elements: only a media element keeps the
/// pitch of speech when its rate changes. Nothing waits for an element to
/// load (a phone does not preload, so `canplay` never comes before a play),
/// and `start` must be called inside the tap, where it plays each element so
/// the browser lets later calls from the frame loop through.
///
/// Sound effects are decoded in the background and scheduled on the
/// AudioContext at their own pitch, their start times divided by the rate.
function createAudio(media, report) {
  const placements = media
    .filter((item) => item.kind === "audio")
    .map((item) => ({
      url: mediaUrl(item.path),
      start: item.timelineStartNanos / 1e9,
      end: item.timelineEndNanos / 1e9,
      sourceStart: item.sourceStartNanos / 1e9,
      gain: 10 ** ((item.gainDb ?? 0) / 20),
      voice: item.role === "script" || (item.timelineEndNanos - item.timelineStartNanos) / 1e9 > VOICE_SECONDS,
    }));
  const effects = placements.filter((placement) => !placement.voice);
  const voices = placements.filter((placement) => placement.voice);
  const position = (placement, time) => placement.sourceStart + (time - placement.start);
  const inside = (placement, time) => time >= placement.start && time < placement.end - 0.02;

  for (const voice of voices) {
    const element = new Audio();
    element.preload = "auto";
    element.preservesPitch = true;
    element.webkitPreservesPitch = true;
    // Element volume cannot amplify; a voice louder than its file plays as it is.
    element.volume = Math.min(1, voice.gain);
    element.addEventListener("error", () => {
      voice.failed = true;
      report.failed(`audio: cannot play ${voice.url}`);
    });
    element.src = voice.url;
    Object.assign(voice, { element, failed: false, blocked: false, seating: 0 });
  }

  const context = new AudioContext();
  const buffers = new Map();
  let playing = false;
  let scheduled = [];
  // Effects need (re)scheduling from the current time on the next `follow`.
  let stale = false;
  for (const url of new Set(effects.map((placement) => placement.url))) {
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .then((buffer) => {
        buffers.set(url, buffer);
        stale = true;
      })
      .catch((error) => console.warn(`sound effect ${url}: ${error.message ?? error}`));
  }

  const silence = () => {
    for (const source of scheduled) source.stop();
    scheduled = [];
  };
  const schedule = (time, rate) => {
    silence();
    const origin = context.currentTime;
    for (const placement of effects) {
      const buffer = buffers.get(placement.url);
      if (!buffer || placement.end <= time) continue;
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = placement.gain;
      source.connect(gain).connect(context.destination);
      const from = Math.max(time, placement.start);
      source.start(origin + (from - time) / rate, position(placement, from), placement.end - from);
      scheduled.push(source);
    }
  };
  /// Put a voice at scene time `time` and play it. Up to three more attempts
  /// follow from `follow` if the browser dropped the position (an element with
  /// nothing loaded yet may start from zero).
  const seat = (voice, time, rate) => {
    const element = voice.element;
    element.defaultPlaybackRate = rate;
    element.playbackRate = rate;
    try {
      element.currentTime = position(voice, time);
    } catch {
      // Refused before any data is loaded on some browsers; `follow` retries.
    }
    voice.seating = 3;
    element.play()?.catch((error) => {
      if (error.name !== "NotAllowedError" || voice.blocked) return;
      voice.blocked = true;
      report.blocked();
    });
  };

  return {
    /// Begin playing from scene time `time`. Call inside the user's tap.
    start(time, rate) {
      playing = true;
      context.resume().catch(() => {});
      for (const voice of voices) {
        if (voice.failed) continue;
        voice.blocked = false;
        if (inside(voice, time)) {
          seat(voice, time, rate);
        } else {
          // Not due yet: play and pause at once, which makes no sound but
          // marks the element as started by the user.
          voice.element.play()?.catch(() => {});
          voice.element.pause();
        }
      }
      stale = true;
    },
    stop() {
      playing = false;
      silence();
      for (const voice of voices) voice.element.pause();
    },
    /// The clock moved to `time` while playing.
    seek(time, rate) {
      for (const voice of voices) {
        if (voice.failed) continue;
        if (inside(voice, time)) seat(voice, time, rate);
        else voice.element.pause();
      }
      silence();
      stale = true;
    },
    setRate(rate) {
      for (const voice of voices) {
        voice.element.defaultPlaybackRate = rate;
        voice.element.playbackRate = rate;
      }
      stale = true;
    },
    /// The picture stopped following the wall clock (it is holding, or it
    /// jumped): drop the scheduled effects and place them again when it moves.
    restage() {
      silence();
      stale = true;
    },
    /// Keep the voices in step with scene time `time`, once per frame.
    /// Returns `{ time }`, the scene time a sounding voice is at (the
    /// authority for the clock); "waiting" if a voice is due but not sounding
    /// yet; or null where no voice plays.
    follow(time, rate) {
      if (!playing) return null;
      let state = null;
      for (const voice of voices) {
        const element = voice.element;
        if (voice.failed || voice.blocked) continue;
        if (!inside(voice, time)) {
          if (!element.paused) element.pause();
          continue;
        }
        if (element.ended) continue;
        if (element.paused) {
          seat(voice, time, rate);
          state ??= "waiting";
          continue;
        }
        if (element.playbackRate !== rate) element.playbackRate = rate;
        if (element.seeking || element.readyState < 3) {
          state ??= "waiting";
          continue;
        }
        if (voice.seating > 0 && Math.abs(element.currentTime - position(voice, time)) > 0.3) {
          voice.seating -= 1;
          element.currentTime = position(voice, time);
          state ??= "waiting";
          continue;
        }
        voice.seating = 0;
        if (state === null || state === "waiting") {
          state = { time: voice.start + (element.currentTime - voice.sourceStart) };
        }
      }
      if (stale && state !== "waiting") {
        schedule(time, rate);
        stale = false;
      }
      return state;
    },
    voices: () =>
      voices.map(({ element, start, sourceStart }) => ({
        sceneTime: start + (element.currentTime - sourceStart),
        currentTime: element.currentTime,
        playbackRate: element.playbackRate,
        preservesPitch: element.preservesPitch ?? element.webkitPreservesPitch,
        paused: element.paused,
        seeking: element.seeking,
        readyState: element.readyState,
      })),
  };
}

main().catch((error) => {
  console.error(error);
  message(String(error.message ?? error));
});
