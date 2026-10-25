import { command, githubAnnotation } from './github-command.mjs';

const repository = process.env.GITHUB_REPOSITORY || '';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository.');
const route = `repos/${repository}/pages`;
const current = command('gh', ['api', route], { allowFailure: true });
if (current.ok) {
  const config = JSON.parse(current.output);
  if (config.build_type === 'workflow') {
    console.log('GitHub Pages already uses the explicit deployment workflow; no configuration change is needed.');
    process.exit(0);
  }
  console.log('GitHub Pages is enabled. The static branch deployment will check and select its workflow build mode.');
  process.exit(0);
}
if (!/404|not found/i.test(current.error)) {
  githubAnnotation(`GitHub Pages configuration could not be read: ${current.error}`);
  process.exit(1);
}
githubAnnotation('The published site branch exists, but GitHub reports that Pages is not enabled. The workflow token cannot receive repository administration permission. An administrator must select Settings → Pages → GitHub Actions.');
process.exit(1);
