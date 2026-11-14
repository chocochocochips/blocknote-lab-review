import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { RequestError } from '../server/validation.mjs';

const repository = 'chocochocochips/blocknote-shared-memory';
const branch = 'main';
const endpoint = 'https://api.github.com/repos/' + repository;

export function githubPublication(token, fetchGitHub = fetch) {
  if (!token?.trim()) return undefined;
  async function request(path, method = 'GET', body) {
    try {
      return await fetchGitHub(endpoint + path, {
        method,
        // Workers supports manual redirects. Never follow a redirect with the token.
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'BlockNote-Lab-Publication',
          Authorization: 'Bearer ' + token.trim(),
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body && JSON.stringify(body),
      });
    } catch {
      throw new RequestError(502, 'PUBLICATION_UNCERTAIN', '저장소 응답을 확인하지 못했어요. 공개 저장소에서 발행 결과를 확인하거나 다시 시도하세요.');
    }
  }
  async function readJson(response) {
    try { return await response.json(); }
    catch { throw new RequestError(502, 'PUBLICATION_BAD_RESPONSE', '공개 저장소 응답을 해석할 수 없어요.'); }
  }
  async function requireOk(response) {
    if (response.ok) return;
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) {
      throw new RequestError(502, 'PUBLICATION_DESTINATION_REDIRECT', 'GitHub가 다른 주소를 반환했어요. 공개 저장소의 주소를 확인해 주세요.');
    }
    if (response.status === 409 || response.status === 422) {
      throw new RequestError(409, 'PUBLICATION_DESTINATION_CONFLICT', '공개 저장소가 쓰기를 거절했어요. 파일 변경 또는 브랜치 설정을 확인해 주세요.');
    }
    throw new RequestError(502, 'PUBLICATION_DESTINATION_ERROR', '공개 저장소에 접근할 수 없어요. 서버의 저장소 권한과 상태를 확인해 주세요.');
  }
  return {
    async publish({ key, markdown, verifyCurrent }) {
      const repo = await request('');
      await requireOk(repo);
      if ((await readJson(repo))?.visibility !== 'public') {
        throw new RequestError(409, 'PUBLICATION_REPOSITORY_NOT_PUBLIC', '대상 저장소가 공개 상태인지 확인해 주세요.');
      }
      const path = 'memory/blocknote-' + key + '.md';
      const publicUrl = 'https://raw.githubusercontent.com/' + repository + '/' + branch + '/' + path;
      const file = await request('/contents/' + path + '?ref=' + branch);
      let sha;
      if (file.status === 404) {
        await file.body?.cancel();
      } else {
        await requireOk(file);
        const current = await readJson(file);
        if (current?.type !== 'file' || !/^[a-f0-9]{40}$/.test(current.sha || '')) {
          throw new RequestError(409, 'PUBLICATION_PATH_CONFLICT', '공개 저장소에 같은 경로가 이미 사용 중이에요.');
        }
        sha = current.sha;
      }
      const bytes = Buffer.from(markdown);
      const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      await verifyCurrent();
      if (sha === blob) return { publicUrl, unchanged: true };
      const result = await request('/contents/' + path, 'PUT', {
        message: sha ? 'Update published BlockNote document' : 'Publish BlockNote document',
        content: bytes.toString('base64'),
        branch,
        ...(sha && { sha }),
      });
      await requireOk(result);
      await result.body?.cancel();
      return { publicUrl, unchanged: false };
    },
  };
}
