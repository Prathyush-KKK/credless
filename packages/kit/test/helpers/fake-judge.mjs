#!/usr/bin/env node
// A stand-in judge command for the self-tests and smoke tests: reads the judge's prompt on stdin and gives every
// criterion full marks, quoting the first words of the answer (so the quote check passes). Never a real judgement.
let prompt = '';
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const id = /"id": ("[^"]*")/.exec(prompt)?.[1];
  const answer = /ANSWER:\n([\s\S]*?)\n\nFACTS:/.exec(prompt)?.[1] ?? '';
  const criteria = [...prompt.matchAll(/^- ([a-z0-9-]+): /gm)].map((m) => m[1]);
  const quote = answer.trim().split(/\s+/).slice(0, 6).join(' ');
  const scores = criteria.map((criterion) => ({ criterion, score: 2, quote, why: 'stand-in judge' }));
  process.stdout.write(`${JSON.stringify({ id: id ? JSON.parse(id) : '', scores })}\n`);
});
