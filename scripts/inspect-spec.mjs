import fs from 'node:fs';

const lines = fs.readFileSync('openai-openapi.yaml', 'utf8').split(/\r?\n/);

function show(pattern, maxLines) {
  const i = lines.findIndex((l) => pattern.test(l));
  if (i === -1) return `NOT FOUND: ${pattern}`;
  return lines.slice(i, i + maxLines).join('\n');
}

console.log('=== /realtime/calls (webrtc sdp) ===');
console.log(show(/^\s{2}\/realtime\/calls:/, 70));

console.log('\n=== RealtimeCreateClientSecretResponse ===');
console.log(show(/^\s{4}RealtimeCreateClientSecretResponse:/, 45));

console.log('\n=== RealtimeTranscriptionSessionCreateRequestGA (audio input) ===');
console.log(show(/^\s{4}RealtimeTranscriptionSessionCreateRequestGA:/, 150));
