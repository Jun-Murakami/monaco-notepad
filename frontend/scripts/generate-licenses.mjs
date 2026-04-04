import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(__dirname, '..');
const projectRoot = resolve(frontendDir, '..');
const publicDir = resolve(frontendDir, 'public');

// --- Frontend licenses via license-checker ---
function generateFrontendLicenses() {
  console.log('Generating frontend licenses...');
  try {
    const raw = execSync('npx license-checker --json --production', {
      cwd: frontendDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(raw);
    const licenses = Object.entries(data).map(([key, value]) => {
      const atIndex = key.lastIndexOf('@');
      const name = atIndex > 0 ? key.slice(0, atIndex) : key;
      const version = atIndex > 0 ? key.slice(atIndex + 1) : '';
      return {
        name,
        version,
        license: value.licenses || 'Unknown',
        repository: (value.repository || '').replace(/^git\+/, '').replace(/\.git$/, ''),
      };
    });
    licenses.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(resolve(publicDir, 'frontend-licenses.json'), JSON.stringify(licenses, null, 2));
    console.log(`  -> ${licenses.length} frontend packages`);
  } catch (err) {
    console.warn('Warning: Failed to generate frontend licenses:', err.message);
    writeFileSync(resolve(publicDir, 'frontend-licenses.json'), '[]');
  }
}

// --- Backend licenses via go-licenses ---
function generateBackendLicenses() {
  console.log('Generating backend licenses...');
  try {
    const raw = execSync('go-licenses csv .', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const licenses = raw
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [modulePath, url, licenseType] = line.split(',');
        return {
          name: modulePath || '',
          license: licenseType || 'Unknown',
          repository: url || '',
        };
      });
    licenses.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(resolve(publicDir, 'backend-licenses.json'), JSON.stringify(licenses, null, 2));
    console.log(`  -> ${licenses.length} backend packages`);
  } catch (err) {
    console.warn('Warning: Failed to generate backend licenses (is go-licenses installed?):', err.message);
    writeFileSync(resolve(publicDir, 'backend-licenses.json'), '[]');
  }
}

generateFrontendLicenses();
generateBackendLicenses();
console.log('License generation complete.');
