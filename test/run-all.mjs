// Lance TOUS les tests Node (test/*.test.mjs) les uns après les
// autres, chacun dans son propre processus, et totalise. Les variables
// d'environnement (POH_TEST_OCR, …) sont transmises telles quelles.
// Usage : npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(root)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(root, f));

let failures = 0;
for (const file of files) {
  const name = path.basename(file);
  const ok = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
  console.log(`${ok ? 'SUITE OK  ' : 'SUITE ÉCHEC'} ${name}`);
  if (!ok) failures++;
}
console.log(failures === 0
  ? `\nTOUTES LES SUITES PASSENT (${files.length} fichiers)`
  : `\n${failures} SUITE(S) EN ÉCHEC sur ${files.length}`);
process.exit(failures === 0 ? 0 : 1);
