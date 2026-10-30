import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, ID, SECOND_ID } from './store-fixture.mjs';

test('Library discovery sorts channels and dates and excludes malformed sidecars instead of weakening the API', async t => {
  const { store, root } = await fixture(t);
  const records = [
    { id: ID, channel: 'zebra', savedAt: '2026-10-29T00:00:00.000Z' },
    { id: SECOND_ID, channel: 'Alpha', savedAt: '2026-10-28T00:00:00.000Z' },
    { id: '22222222222', channel: 'Alpha', savedAt: '2026-10-30T00:00:00.000Z' },
  ];
  for (const record of records) {
    const directory = join(root, record.channel);
    await mkdir(directory, { recursive: true });
    const file = `${record.id}.mp4`;
    await writeFile(join(directory, file), 'media fixture');
    await writeFile(join(directory, `${file}.info.json`), JSON.stringify({ ...record, title: record.id, duration: 12, file }));
  }
  let library = await store.list();
  assert.deepEqual(library.channels.map(item => item.channel), ['Alpha', 'zebra']);
  assert.deepEqual(library.channels[0].videos.map(item => item.id), ['22222222222', SECOND_ID]);
  assert.equal(library.channels[0].videos[0].bytes, 13);
  for (const invalid of [{ duration: undefined }, { savedAt: 1 }, { file: '../outside.mp4' }]) {
    const record = records[0];
    await writeFile(join(root, record.channel, `${ID}.mp4.info.json`),
      JSON.stringify({ ...record, title: ID, duration: 12, file: `${ID}.mp4`, ...invalid }));
    library = await store.list();
    assert.deepEqual(library.channels.map(item => item.channel), ['Alpha']);
  }
});
