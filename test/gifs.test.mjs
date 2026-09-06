// GIF search contract: the renderer names a provider and a query, never a
// host or a URL; keys never appear in this layer; and a malformed provider
// response is skipped rather than guessed at.
import assert from 'node:assert';
import { GIF_HOSTS, MAX_GIF_RESULTS, MAX_QUERY_LENGTH, parseGiphy, parseSearch, parseTenor, searchPath } from './.gifs.mjs';

{
  const p = searchPath('giphy', 'moon rocket', 12);
  assert.ok(p.startsWith('/v1/gifs/search?'), p);
  assert.match(p, /q=moon%20rocket/);
  assert.match(p, /limit=12/);
  assert.match(p, /rating=pg-13/, 'the rating is pinned');
  assert.ok(!/key|api_key/i.test(p), 'no key is ever built here');

  const t = searchPath('tenor', 'moon rocket', 12);
  assert.ok(t.startsWith('/v2/search?'), t);
  assert.match(t, /contentfilter=medium/, 'the filter is pinned');
  assert.ok(!/[?&]key=/.test(t), 'no key is ever built here');
  console.log('ok  a search path carries a query and a rating, never a key');
}

{
  // Limits and query length are clamped in the pure layer, so no caller can
  // ask a provider for a thousand results or paste an essay.
  assert.match(searchPath('giphy', 'x', 9999), new RegExp(`limit=${MAX_GIF_RESULTS}`));
  assert.match(searchPath('giphy', 'x', 0), /limit=1/);
  assert.match(searchPath('giphy', 'x', -5), /limit=1/);
  const long = 'a'.repeat(500);
  const p = searchPath('tenor', long, 5);
  const q = decodeURIComponent(p.split('q=')[1].split('&')[0]);
  assert.equal(q.length, MAX_QUERY_LENGTH, 'the query is cut to the cap');
  console.log('ok  result count and query length are clamped');
}

{
  assert.equal(GIF_HOSTS.giphy, 'api.giphy.com');
  assert.equal(GIF_HOSTS.tenor, 'tenor.googleapis.com');
  console.log('ok  exactly two hosts are reachable');
}

{
  const body = {
    data: [
      {
        id: 'abc',
        title: 'rocket',
        images: {
          downsized: { url: 'https://media.giphy.com/a.gif', width: '480', height: '270' },
          fixed_width_small: { url: 'https://media.giphy.com/small.gif' },
        },
      },
      { id: 'no-images' },
      { id: 'insecure', images: { downsized: { url: 'http://media.giphy.com/b.gif' } } },
      { images: { downsized: { url: 'https://media.giphy.com/c.gif' } } },
    ],
  };
  const items = parseGiphy(body);
  assert.equal(items.length, 1, 'only the complete, https row survives');
  assert.deepEqual(
    { id: items[0].id, full: items[0].fullUrl, preview: items[0].previewUrl, w: items[0].width },
    { id: 'abc', full: 'https://media.giphy.com/a.gif', preview: 'https://media.giphy.com/small.gif', w: 480 },
  );
  assert.deepEqual(parseGiphy({}), []);
  assert.deepEqual(parseGiphy(null), []);
  assert.deepEqual(parseGiphy({ data: 'nope' }), []);
  console.log('ok  GIPHY rows without https media are dropped');
}

{
  const body = {
    results: [
      {
        id: 't1',
        content_description: 'cat',
        media_formats: { gif: { url: 'https://media.tenor.com/a.gif', dims: [200, 100] }, tinygif: { url: 'https://media.tenor.com/t.gif' } },
      },
      { id: 't2', media_formats: { gif: { url: 'ftp://media.tenor.com/b.gif' } } },
    ],
  };
  const items = parseTenor(body);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'cat');
  assert.equal(items[0].height, 100);
  assert.deepEqual(parseTenor({ results: {} }), []);
  console.log('ok  Tenor rows without https media are dropped');
}

{
  assert.equal(parseSearch('giphy', { data: [] }).length, 0);
  assert.equal(parseSearch('tenor', { results: [] }).length, 0);
  console.log('ok  an empty result set is empty, not an error');
}
console.log('gifs: all tests passed');
