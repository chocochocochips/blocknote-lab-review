import app from '../dist/server/index.js';

export default {
  fetch(request, env) {
    const headers = new Headers(request.headers);
    headers.set('oai-authenticated-user-id', 'blocknote-local-preview');
    return app.fetch(new Request(request, { headers }), env);
  },
};
