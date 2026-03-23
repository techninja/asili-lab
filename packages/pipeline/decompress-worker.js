import { parentPort } from 'worker_threads';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';

parentPort.on('message', ({ filePath, id }) => {
  try {
    const compressed = readFileSync(filePath);
    const data = gunzipSync(compressed).toString('utf8');
    parentPort.postMessage({ id, data });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
