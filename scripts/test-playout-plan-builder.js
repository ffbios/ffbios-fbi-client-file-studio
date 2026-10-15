"use strict";

const assert = require("node:assert/strict");
const { buildSchedulePlan } = require("../playout/plan-builder");

const track = (id, episode, duration, series = "Series") => ({
  id, episode, duration_seconds: duration, series, title: id,
  created_at: "2026-01-01T00:00:00.000Z"
});
const promo = (id, duration, series = "Promo: Series") => ({
  id, episode: 1, duration_seconds: duration, series, title: id,
  created_at: "2026-01-01T00:00:00.000Z"
});
const base = {
  show: { contentMode: "episodes", repeatEpisodes: false, promoIntervalMinutes: 10 },
  slotSeconds: 60,
  beforePromoKeys: ["Promo: Series", "Promo: General"],
  afterPromoKeys: [],
  promoPools: {},
  progress: {}
};

{
  const first = buildSchedulePlan({
    ...base,
    media: [track("ep1", 1, 60), track("ep2", 2, 60)],
    slotSeconds: 120
  });
  assert.deepEqual(first.segments.filter((s) => s.kind === "show").map((s) => s.id), ["ep1", "ep2"]);
  assert.equal(first.progress.nextEpisode, 3);

  // Adding/deleting media changes the array length but must not rewind the
  // persisted episode number and repeat the prior episode.
  const next = buildSchedulePlan({
    ...base,
    media: [track("ep0", 0, 60), track("ep1", 1, 60), track("ep2", 2, 60), track("ep3", 3, 60)],
    progress: first.progress
  });
  assert.deepEqual(next.segments.filter((s) => s.kind === "show").map((s) => s.id), ["ep3"]);
}

{
  const result = buildSchedulePlan({
    ...base,
    media: [track("episode", 1, 1500)],
    slotSeconds: 1590,
    promoPools: {
      "Promo: Series": { items: [promo("promo-a", 30)], nextIndex: 0 },
      "Promo: General": { items: [promo("general", 20, "Promo: General")], nextIndex: 0 }
    }
  });
  assert.deepEqual(result.segments.map((s) => [s.kind, s.id, s.offset, s.duration]), [
    ["promo", "promo-a", 0, 30],
    ["show", "episode", 0, 600],
    ["promo", "promo-a", 0, 30],
    ["show", "episode", 600, 600],
    ["promo", "promo-a", 0, 30],
    ["show", "episode", 1200, 300]
  ]);
  assert.ok(result.segments.reduce((sum, s) => sum + s.duration, 0) <= 1590.001);
}

{
  const result = buildSchedulePlan({
    ...base,
    show: { contentMode: "episodes", repeatEpisodes: false, promoIntervalMinutes: 10 },
    media: [track("episode", 1, 1500)],
    slotSeconds: 650,
    progress: { nextEpisode: 1, nextOffset: 600, nextMediaId: "episode", nextIndex: 0 },
    promoPools: {
      "Promo: Series": { items: [promo("promo-a", 20)], nextIndex: 0 }
    }
  });
  const episodeSegments = result.segments.filter((s) => s.kind === "show");
  assert.equal(episodeSegments[0].offset, 600);
  assert.equal(episodeSegments.at(-1).offset + episodeSegments.at(-1).duration, 1210);
  assert.equal(result.progress.nextOffset, 1210);
}

{
  const result = buildSchedulePlan({
    ...base,
    show: { contentMode: "playlist", repeatEpisodes: false, promoIntervalMinutes: 10 },
    media: [track("music-a", 1, 480, "Music"), track("music-b", 2, 480, "Music")],
    slotSeconds: 1020,
    beforePromoKeys: ["Promo: General"],
    promoPools: { "Promo: General": { items: [promo("station-promo", 30, "Promo: General")], nextIndex: 0 } }
  });
  assert.deepEqual(result.segments.map((s) => s.id), ["station-promo", "music-a", "music-b", "station-promo"]);
  assert.equal(result.progress.nextMediaId, "music-a");
  assert.equal(result.progress.nextOffset, 0);
  assert.ok(result.segments.reduce((sum, s) => sum + s.duration, 0) <= 1020.001);
}

{
  const result = buildSchedulePlan({
    ...base,
    media: [track("ep1", 1, 30), track("ep2", 2, 30)],
    slotSeconds: 180
  });
  assert.deepEqual(result.segments.map((s) => s.id), ["ep1", "ep2"]);
  assert.equal(result.progress.nextEpisode, 3);
}

{
  const result = buildSchedulePlan({
    ...base,
    media: [track("ep1", 1, 60), track("ep2", 2, 60)],
    slotSeconds: 60,
    legacyEpisodeIndex: true,
    progress: { nextIndex: 3, nextEpisode: null, nextMediaId: null }
  });
  assert.deepEqual(result.segments, []);
}

{
  const result = buildSchedulePlan({
    ...base,
    media: [track("ep1", 1, 30), track("ep2", 2, 30)],
    slotSeconds: 180,
    afterPromoKeys: ["Promo: Series"],
    promoPools: { "Promo: Series": { items: [promo("between-episodes", 10)], nextIndex: 0 } }
  });
  assert.deepEqual(result.segments.map((s) => [s.kind, s.id]), [
    ["promo", "between-episodes"],
    ["show", "ep1"],
    ["promo", "between-episodes"],
    ["show", "ep2"]
  ]);
}

console.log("Playout plan-builder tests passed.");
