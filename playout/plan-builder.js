"use strict";

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function episodeNo(item) {
  if (item == null || item.episode == null || item.episode === "") return null;
  const n = Number(item.episode);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function durationOf(item) {
  return Math.max(0, finite(item && item.duration_seconds, 0));
}
function orderMedia(a, b) {
  const ea = episodeNo(a), eb = episodeNo(b);
  if (ea != null && eb != null && ea !== eb) return ea - eb;
  if (ea != null && eb == null) return -1;
  if (ea == null && eb != null) return 1;
  const ca = String(a.created_at || "");
  const cb = String(b.created_at || "");
  if (ca !== cb) return ca.localeCompare(cb);
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Build a fixed, deterministic playout rundown for one scheduled slot.
 * Segment durations are broadcast durations; offset is the position in the
 * source file. A segment may represent only part of an episode.
 */
function buildSchedulePlan(options) {
  const opt = options || {};
  const show = opt.show || {};
  const slotSeconds = Math.max(0, finite(opt.slotSeconds, 0));
  const mode = show.contentMode === "playlist" ? "playlist" : "episodes";
  const repeatEpisodes = show.repeatEpisodes === true;
  const legacyEpisodeIndex = opt.legacyEpisodeIndex === true;
  const intervalMinutes = Math.max(0, Math.min(120, finite(show.promoIntervalMinutes, 10)));
  const intervalSeconds = intervalMinutes > 0 ? intervalMinutes * 60 : 0;
  const media = (Array.isArray(opt.media) ? opt.media : [])
    .filter((m) => m && m.id && durationOf(m) > 0)
    .slice()
    .sort(orderMedia);
  const sourceProgress = opt.progress || {};
  let nextIndex = Math.max(0, Math.floor(finite(sourceProgress.nextIndex, 0)));
  let nextEpisode = episodeNo({ episode: sourceProgress.nextEpisode });
  let nextOffset = Math.max(0, finite(sourceProgress.nextOffset, 0));
  let nextMediaId = sourceProgress.nextMediaId == null ? null : String(sourceProgress.nextMediaId);
  let promoClockSeconds = Math.max(0, finite(sourceProgress.promoClockSeconds, 0));
  let remaining = slotSeconds;
  const segments = [];
  const promoPools = opt.promoPools || {};
  const beforeKeys = Array.isArray(opt.beforePromoKeys) ? opt.beforePromoKeys : [];
  const afterKeys = Array.isArray(opt.afterPromoKeys) ? opt.afterPromoKeys : [];
  const poolState = new Map();

  for (const [key, value] of Object.entries(promoPools)) {
    const items = ((value && value.items) || [])
      .filter((m) => m && m.id && durationOf(m) > 0)
      .slice()
      .sort(orderMedia);
    const rawIndex = Math.max(0, Math.floor(finite(value && value.nextIndex, 0)));
    poolState.set(key, { items, index: items.length ? rawIndex % items.length : 0 });
  }

  function append(item, offset, duration, kind) {
    const safeDuration = Math.max(0, Math.min(remaining, finite(duration, 0)));
    if (!item || safeDuration <= 0.001) return false;
    segments.push({
      id: item.id,
      series: item.series || "",
      offset: Math.max(0, finite(offset, 0)),
      duration: safeDuration,
      kind,
      title: item.title || item.filename || item.series || "",
      episode: episodeNo(item)
    });
    remaining = Math.max(0, remaining - safeDuration);
    return true;
  }

  // Returns "added", "none" (no promo uploaded), or "no-fit" (promos exist,
  // but none can fit before the next hard schedule boundary).
  function addPromo(keys) {
    if (remaining <= 0.001) return "no-fit";
    let anyAvailable = false;
    for (const key of [...new Set(keys || [])]) {
      const pool = poolState.get(key);
      if (!pool || !pool.items.length) continue;
      anyAvailable = true;
      for (let step = 0; step < pool.items.length; step++) {
        const ix = (pool.index + step) % pool.items.length;
        const item = pool.items[ix];
        const d = durationOf(item);
        if (d <= remaining + 0.001) {
          append(item, 0, d, "promo");
          pool.index = (ix + 1) % pool.items.length;
          return "added";
        }
      }
    }
    return anyAvailable ? "no-fit" : "none";
  }

  function chooseEpisodeIndex() {
    if (nextMediaId) {
      const found = media.findIndex((m) => String(m.id) === nextMediaId);
      if (found >= 0 && (nextOffset > 0 || nextEpisode == null || episodeNo(media[found]) === nextEpisode)) return found;
    }
    const hasNumbers = media.some((m) => episodeNo(m) != null);
    if (hasNumbers && nextEpisode != null) {
      const found = media.findIndex((m) => {
        const n = episodeNo(m);
        return n != null && n >= nextEpisode;
      });
      if (found >= 0) return found;
      if (repeatEpisodes) return 0;
      const unnumbered = media.findIndex((m, i) => i >= nextIndex && episodeNo(m) == null);
      return unnumbered;
    }
    if (nextIndex < media.length) return nextIndex;
    // During the first rollout, old progress rows have only an array index.
    // Use it once as a fallback if historical airing data cannot recover a
    // stable pointer; the saved plan will then persist an episode number.
    // Never modulo-wrap a numbered episodic library during legacy migration:
    // if the old index cannot be reconciled with today's media list, go to
    // filler instead of risking another repeat of an already-aired episode.
    if (legacyEpisodeIndex && hasNumbers) return -1;
    return repeatEpisodes && media.length ? nextIndex % media.length : -1;
  }

  function setEpisodePending(item, ix, offset, completed) {
    const n = episodeNo(item);
    if (completed) {
      nextOffset = 0;
      nextIndex = ix + 1;
      nextEpisode = n == null ? null : n + 1;
      nextMediaId = null;
    } else {
      nextOffset = Math.max(0, offset);
      nextIndex = ix;
      nextEpisode = n;
      nextMediaId = String(item.id);
    }
  }

  if (slotSeconds > 0.001 && media.length && (mode === "playlist" || chooseEpisodeIndex() >= 0)) {
    const preRoll = addPromo(beforeKeys);
    if (preRoll === "added") promoClockSeconds = 0;

    if (mode === "playlist") {
      let ix = nextMediaId ? media.findIndex((m) => String(m.id) === nextMediaId) : -1;
      if (ix < 0) ix = nextIndex < media.length ? nextIndex : nextIndex % media.length;
      let offset = ix >= 0 && String(media[ix].id) === nextMediaId ? nextOffset : 0;
      let guard = 0;
      while (remaining > 0.001 && media.length && guard++ < 2000) {
        const item = media[ix];
        const total = durationOf(item);
        if (offset >= total - 0.05) offset = 0;
        const playFor = Math.min(remaining, total - offset);
        append(item, offset, playFor, "show");
        offset += playFor;
        if (offset >= total - 0.05) {
          offset = 0;
          ix = (ix + 1) % media.length;
          nextIndex = ix;
          nextMediaId = String(media[ix].id);
          nextEpisode = episodeNo(media[ix]);
          nextOffset = 0;
          promoClockSeconds += playFor;
          if (intervalSeconds > 0 && promoClockSeconds >= intervalSeconds - 0.001) {
            const status = addPromo(beforeKeys);
            if (status === "added") promoClockSeconds = 0;
            else if (status === "no-fit") break;
          }
        } else {
          nextIndex = ix;
          nextMediaId = String(item.id);
          nextEpisode = episodeNo(item);
          nextOffset = offset;
          promoClockSeconds += playFor;
          break;
        }
      }
      if (media.length && nextMediaId == null) {
        nextIndex = ix;
        nextMediaId = String(media[ix].id);
        nextEpisode = episodeNo(media[ix]);
      }
    } else {
      let firstEpisode = true;
      let guard = 0;
      while (remaining > 0.001 && guard++ < 2000) {
        const ix = chooseEpisodeIndex();
        if (ix < 0) break;
        const item = media[ix];
        const total = durationOf(item);
        let offset = nextMediaId && String(item.id) === nextMediaId ? nextOffset : 0;
        if (offset >= total - 0.05) offset = 0;

        // The slot-level pre-roll also serves as the pre-roll for its first
        // episode, including a resumed episode. Later episodes get one too.
        if (!firstEpisode && offset <= 0.001) {
          const status = addPromo(beforeKeys);
          if (status === "no-fit") {
            setEpisodePending(item, ix, 0, false);
            break;
          }
        }
        firstEpisode = false;
        let finished = false;
        while (remaining > 0.001 && offset < total - 0.05) {
          const untilBreak = intervalSeconds > 0
            ? intervalSeconds - (offset % intervalSeconds)
            : total - offset;
          const playFor = Math.min(remaining, total - offset, untilBreak);
          if (playFor <= 0.001) break;
          append(item, offset, playFor, "show");
          offset += playFor;
          if (offset >= total - 0.05) {
            finished = true;
            setEpisodePending(item, ix, total, true);
            if (afterKeys.length) addPromo(afterKeys);
            break;
          }
          if (intervalSeconds > 0 && Math.abs(offset / intervalSeconds - Math.round(offset / intervalSeconds)) < 0.0001) {
            const status = addPromo(beforeKeys);
            if (status === "no-fit") {
              setEpisodePending(item, ix, offset, false);
              break;
            }
          }
        }
        if (!finished) {
          if (nextOffset < offset || String(nextMediaId || "") !== String(item.id)) setEpisodePending(item, ix, offset, false);
          break;
        }

        // Never wrap through the same episode library unless looping was
        // explicitly requested. Newly added episodes stay discoverable by number.
        const nextIx = chooseEpisodeIndex();
        if (nextIx < 0) break;
        if (nextIx === ix) {
          if (!repeatEpisodes) break;
          nextIndex = 0;
          nextEpisode = episodeNo(media[0]);
          nextMediaId = null;
          nextOffset = 0;
        }
      }
    }
  }

  const promoProgress = {};
  for (const [key, pool] of poolState) {
    if (pool.items.length) promoProgress[key] = pool.index;
  }
  return {
    segments,
    progress: { nextIndex, nextEpisode, nextOffset, nextMediaId, promoClockSeconds },
    promoProgress
  };
}

module.exports = { buildSchedulePlan };
