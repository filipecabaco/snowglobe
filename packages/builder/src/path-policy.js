// These conventional credential stores are never project source. This is a
// path boundary, not a promise to detect arbitrary secrets pasted into code.
const privateNames=new Set(['.git','.env','.npmrc','.yarnrc','.yarnrc.yml','.pypirc','.netrc','_netrc','.git-credentials','.ssh','.aws','.azure','.gcloud','.gnupg']);
export const privatePathSegment=name=>privateNames.has(name)||name.startsWith('.env.');
