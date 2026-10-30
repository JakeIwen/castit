import test from 'node:test';
import assert from 'node:assert/strict';
import { CastQueue } from '../../src/queue/cast-queue.mjs';
import { playerFixture, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

function deferredLookup() {
  const pending = [];
  return { pending, castQueue: new CastQueue({ lookupTitle: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }) };
}

test('mpv URL placeholders never replace sender or resolved titles, but real metadata does', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  await player.play({ ...VIDEO, title: 'Sender title' });
  for (const title of [VIDEO.id, `watch?v=${VIDEO.id}`, `https://www.youtube.com/watch?v=${VIDEO.id}`]) {
    instances[0].property('media-title', title);
    assert.equal(player.video.title, 'Sender title');
  }
  instances[0].property('media-title', 'Real mpv title');
  assert.equal(player.video.title, 'Real mpv title');
  instances[0].property('media-title', `watch?v=${VIDEO.id}`);
  assert.equal(player.video.title, 'Real mpv title');
});

test('Direct title lookup overlaps loading, fills placeholders and leaves real metadata alone', async t => {
  const { castQueue, pending } = deferredLookup();
  let finishResolution;
  const resolution = new Promise(resolve => { finishResolution = resolve; });
  const { player, instances } = playerFixture({ castQueue, resolver: { resolve: () => resolution } });
  t.after(() => player.endSession());
  const video = { ...VIDEO };
  const playing = player.play(video);
  const title = player.resolveVideoTitle(video);
  await settleUntil(() => player.video);
  assert.equal(player.video.title, VIDEO.id);
  pending[0].resolve(' oEmbed  title ');
  await title;
  assert.equal(player.video.title, 'oEmbed title');
  finishResolution(null);
  await playing;
  const second = { ...SECOND };
  const next = player.play(second);
  const nextTitle = player.resolveVideoTitle(second);
  await next;
  instances[1].property('media-title', 'Real metadata');
  pending[1].resolve('Late oEmbed');
  await nextTitle;
  assert.equal(player.video.title, 'Real metadata');
});

test('An early lookup fills the first load snapshot, failures are silent, and stale same-id lookups are ignored', async t => {
  const { castQueue, pending } = deferredLookup();
  const { player } = playerFixture({ castQueue });
  t.after(() => player.endSession());
  const first = { ...VIDEO };
  const old = player.play(first);
  const oldTitle = player.resolveVideoTitle(first);
  const replacement = { ...VIDEO };
  const next = player.play(replacement);
  const nextTitle = player.resolveVideoTitle(replacement);
  pending[1].resolve('Early title');
  await nextTitle;
  await next;
  assert.equal(await old, false);
  pending[0].resolve('Stale same-id title');
  await oldTitle;
  assert.equal(player.video.title, 'Early title');
  const staleVideo = { ...VIDEO };
  await player.play(staleVideo);
  const staleTitle = player.resolveVideoTitle(staleVideo);
  await player.play({ ...VIDEO });
  pending[2].resolve('Stale placeholder title');
  await staleTitle;
  assert.equal(player.video.title, VIDEO.id);
  const second = { ...SECOND };
  await player.play(second);
  const failed = player.resolveVideoTitle(second);
  pending[3].reject(new Error('private lookup failure'));
  await failed;
  assert.equal(player.video.title, SECOND.id);
  const stoppedTitle = player.resolveVideoTitle(second);
  await player.stop();
  pending[4].resolve('After stop');
  await stoppedTitle;
  assert.equal(player.video, null);
});
