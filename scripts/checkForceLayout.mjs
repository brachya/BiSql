import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../media/schema.js', import.meta.url), 'utf8');
const start = src.indexOf('function forceDirectedPositions');
assert.ok(start >= 0);
const open = src.indexOf('{', start);
let depth = 0;
let end = open;
for (; end < src.length; end++) {
  if (src[end] === '{') depth++;
  else if (src[end] === '}') {
    depth--;
    if (depth === 0) {
      end++;
      break;
    }
  }
}
const forceDirectedPositions = new Function('nodes', 'edges', src.slice(open + 1, end - 1));

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const linked = [
  { x: 0, y: 0, w: 80, h: 40 },
  { x: 0, y: 0, w: 80, h: 40 }
];
forceDirectedPositions(linked, [[0, 1]]);
const apart = [
  { x: 0, y: 0, w: 80, h: 40 },
  { x: 0, y: 0, w: 80, h: 40 }
];
forceDirectedPositions(apart, []);
assert.ok(dist(linked[0], linked[1]) < dist(apart[0], apart[1]));
assert.ok(Number.isFinite(linked[0].x) && Number.isFinite(linked[1].y));

const hub = [];
for (let i = 0; i < 7; i++) hub.push({ x: 0, y: 0, w: 40, h: 20 });
const hubEdges = [];
for (let i = 1; i < 7; i++) hubEdges.push([0, i]);
forceDirectedPositions(hub, hubEdges);
let cx = 0;
let cy = 0;
for (const node of hub) {
  cx += node.x;
  cy += node.y;
}
cx /= hub.length;
cy /= hub.length;
const hubDist = Math.hypot(hub[0].x - cx, hub[0].y - cy);
let leafDist = 0;
for (let i = 1; i < hub.length; i++) {
  leafDist += Math.hypot(hub[i].x - cx, hub[i].y - cy);
}
leafDist /= 6;
assert.ok(hubDist < leafDist);

const boxes = [
  { x: 0, y: 0, w: 200, h: 120 },
  { x: 0, y: 0, w: 200, h: 120 },
  { x: 0, y: 0, w: 200, h: 120 }
];
forceDirectedPositions(boxes, [[0, 1], [1, 2]]);
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const overlapX = (boxes[i].w + boxes[j].w) / 2 - Math.abs(boxes[i].x - boxes[j].x);
    const overlapY = (boxes[i].h + boxes[j].h) / 2 - Math.abs(boxes[i].y - boxes[j].y);
    assert.ok(overlapX <= 1 || overlapY <= 1);
  }
}

const sepStart = src.indexOf('function separateCenters');
assert.ok(sepStart >= 0);
const sepOpen = src.indexOf('{', sepStart);
depth = 0;
end = sepOpen;
for (; end < src.length; end++) {
  if (src[end] === '{') depth++;
  else if (src[end] === '}') {
    depth--;
    if (depth === 0) {
      end++;
      break;
    }
  }
}
const separateCenters = new Function('nodes', src.slice(sepOpen + 1, end - 1));
const stacked = [
  { x: 100, y: 50, w: 200, h: 80 },
  { x: 100, y: 90, w: 200, h: 200 }
];
separateCenters(stacked);
const stackedOverlapY =
  (stacked[0].h + stacked[1].h) / 2 + 40 - Math.abs(stacked[0].y - stacked[1].y);
assert.ok(stackedOverlapY <= 0);

console.log('checkForceLayout: ok');
