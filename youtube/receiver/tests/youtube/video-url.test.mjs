import assert from 'node:assert/strict';
import test from 'node:test';
import { findYouTubeVideo, parseStartTime, parseYouTubeVideo } from '../../src/youtube/video-url.mjs';

const id = 'dQw4w9WgXcQ';

test('YouTube links accept each supported host, protocol and video path', () => {
  for (const protocol of ['http', 'https']) {
    for (const host of ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com']) {
      for (const path of [`watch?v=${id}&`, `shorts/${id}?`, `live/${id}?`, `embed/${id}/?`]) {
        const url = `${protocol}://${host}/${path}si=share&feature=shared&list=PLtest&t=1h2m3s`;
        assert.deepEqual(parseYouTubeVideo(url), { videoId: id, position: 3723 }, url);
      }
    }
    for (const host of ['youtu.be', 'www.youtu.be']) {
      for (const slash of ['', '/']) {
        const url = `${protocol}://${host}/${id}${slash}?si=share&t=4.5`;
        assert.deepEqual(parseYouTubeVideo(url), { videoId: id, position: 4.5 }, url);
      }
    }
  }
  assert.deepEqual(parseYouTubeVideo(` \nHTTPS://YOUTUBE.COM/watch?v=${id}\t `), { videoId: id, position: 0 });
});

test('Link timestamps use t, then start, then the t fragment and ignore invalid times', () => {
  for (const [suffix, position] of [['?t=75', 75], ['?start=13', 13], ['#t=2m', 120],
    ['?start=13&t=4#t=90', 4], ['?start=13#t=90', 13], ['?t=0&start=13', 0],
    ['?t=&start=13#t=90', 0], ['?t=-1', 0], ['?t=1m30s', 90], ['#t=2H3M4.5S', 7384.5]]) {
    assert.deepEqual(parseYouTubeVideo(`https://youtu.be/${id}${suffix}`), { videoId: id, position });
  }
  for (const value of ['', '-1', 'Infinity', '1e3', 'abc', '1:30', '2s1m', 'h', null, '9'.repeat(400)]) {
    assert.equal(parseStartTime(value), 0, String(value));
  }
  for (const [value, position] of [['0', 0], ['90s', 90], ['1h', 3600], ['1h2m3s', 3723], ['2m3.5s', 123.5]]) {
    assert.equal(parseStartTime(value), position, value);
  }
});

test('Link parsing rejects non-video pages, lookalikes, credentials, ports and embedded URLs', () => {
  const urls = [
    '', null, undefined, 123, {}, [], 'not a URL', id,
    `Watch this https://youtu.be/${id}`, `https://youtu.be/${id} more text`,
    `https://www.youtube.com.evil.test/watch?v=${id}`, `https://evil.test/watch?v=${id}`,
    `https://www.youtube.com@evil.test/watch?v=${id}`, `https://user:secret@www.youtube.com/watch?v=${id}`,
    `https://@www.youtube.com/watch?v=${id}`, `https://www.youtube.com:444/watch?v=${id}`,
    `https://www.youtube.com:443/watch?v=${id}`, `http://youtu.be:80/${id}`,
    `ftp://www.youtube.com/watch?v=${id}`, `//www.youtube.com/watch?v=${id}`,
    `https:youtube.com/watch?v=${id}`, `https:///youtube.com/watch?v=${id}`,
    `https://you\ntube.com/watch?v=${id}`, `https://youtube.com\\watch?v=${id}`,
    `https://www.youtube.com/playlist?list=${id}`, `https://youtube.com/?v=${id}`,
    `https://youtu.be/${id}/extra`, `https://youtube.com/shorts/${id}/extra`,
    `https://youtube.com/watch?v=${id}a`, 'https://youtube.com/watch?v=short',
    'https://youtube.com/watch', 'https://youtube.com/watch?v=abcdefghij%2F',
  ];
  for (const url of urls) assert.equal(parseYouTubeVideo(url), null, String(url));
});

test('Link parsing caps the complete input at 2048 characters', () => {
  const prefix = `https://youtu.be/${id}?si=`;
  const url = prefix + 'x'.repeat(2048 - prefix.length);
  assert.deepEqual(parseYouTubeVideo(url), { videoId: id, position: 0 });
  assert.equal(parseYouTubeVideo(`${url}x`), null);
  assert.equal(parseYouTubeVideo(` ${url}`), null);
});

test('Shared text finds the first YouTube video and preserves its timestamp', () => {
  const cases = [
    [`https://youtu.be/${id}?si=x&t=90s`, 90],
    [`Title https://youtu.be/${id}?si=x`, 0],
    [`https://m.youtube.com/shorts/${id}?feature=share — check this out`, 0],
    [`Watch this\nhttps://youtu.be/${id}#t=2m\tmore text`, 120],
    [`https://youtu.be/${id}.`, 0],
    [`https://example.com/video https://youtu.be/${id}?t=4.5`, 4.5],
    [`https://youtube.com/playlist?list=PLtest https://youtu.be/${id}?start=13`, 13],
    [`https://youtu.be/${id}?t=75 https://youtu.be/jNQXAC9IVRw?t=90`, 75],
    [`Watch “https://youtu.be/${id}?t=90” then https://youtu.be/jNQXAC9IVRw`, 90],
    [`(https://youtu.be/${id})`, 0],
    [`<https://youtu.be/${id}>`, 0],
    [`“https://youtu.be/${id}”`, 0],
    [`[https://youtu.be/${id}].`, 0],
  ];
  for (const [text, position] of cases) {
    assert.deepEqual(findYouTubeVideo(text), { videoId: id, position }, text);
  }
  for (const punctuation of ['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', "'", '"', '’', '”', '»', '›', '`', ').”']) {
    const text = `Watch https://youtu.be/${id}?t=1m30s${punctuation}`;
    assert.deepEqual(findYouTubeVideo(text), { videoId: id, position: 90 }, text);
  }
  for (const opening of ['"', "'", '“', '‘', '„', '‹', '«', '(', '[', '{', '<']) {
    const text = `${opening}https://youtu.be/${id}`;
    assert.deepEqual(findYouTubeVideo(text), { videoId: id, position: 0 }, text);
  }
});

test('Shared text keeps supported bare link parsing unchanged', () => {
  for (const host of ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com']) {
    for (const path of [`watch?v=${id}&`, `shorts/${id}?`, `live/${id}?`, `embed/${id}/?`]) {
      const url = `https://${host}/${path}si=share&t=1h2m3s`;
      assert.deepEqual(findYouTubeVideo(url), parseYouTubeVideo(url), url);
    }
  }
  for (const url of [`http://youtu.be/${id}`, ` https://www.youtu.be/${id}/#t=4.5 `]) {
    assert.deepEqual(findYouTubeVideo(url), parseYouTubeVideo(url), url);
  }
});

test('Shared text rejects missing videos and bounds both text and individual links', () => {
  for (const text of ['', ' \n\t ', '“”', 'Title with no link', 'https://example.com/video',
    `https://youtu.be/${id}/extra`, `https://youtube.com.evil.test/watch?v=${id}`,
    `https://user:secret@youtube.com/watch?v=${id}`, null, undefined, 123, {}, []]) {
    assert.equal(findYouTubeVideo(text), null, String(text));
  }
  const url = `https://youtu.be/${id}?t=90`;
  const text = 'x'.repeat(4096 - url.length - 1) + ` ${url}`;
  assert.deepEqual(findYouTubeVideo(text), { videoId: id, position: 90 });
  assert.equal(findYouTubeVideo(` ${text}`), null);
  const prefix = `https://youtu.be/${id}?si=`;
  const longUrl = prefix + 'x'.repeat(2048 - prefix.length);
  assert.deepEqual(findYouTubeVideo(`Title ${longUrl}`), { videoId: id, position: 0 });
  assert.equal(findYouTubeVideo(`Title ${longUrl}x`), null);
});
