// Every approval belongs to one host task. Preview messages cannot grant it.
export function createApprovalPrompt(dialog) {
 let pending;
 return (request, signal) => new Promise((resolve, reject) => {
  if (pending) return reject(new Error('Another action is awaiting approval'));
  if (signal?.aborted) return reject(signal.reason || new Error('Task stopped'));
  const ticket=Symbol('approval');
  const finish = (approved, error) => {
   if (pending!==ticket) return;
   pending = null;
   signal?.removeEventListener('abort', cancel);
   dialog.removeEventListener('cancel', deny);
   dialog.querySelector('[data-approve]').onclick = null;
   dialog.querySelector('[data-deny]').onclick = null;
   dialog.close();
   error ? reject(error) : resolve(approved);
  };
  const cancel = () => finish(false, signal.reason || new Error('Task stopped'));
  const deny = event => {event?.preventDefault(); finish(false);};
  dialog.querySelector('[data-title]').textContent = request.title;
  dialog.querySelector('[data-description]').textContent = request.description;
  dialog.querySelector('[data-content]').textContent = request.content || '';
  dialog.querySelector('[data-approve]').onclick = () => finish(true);
  dialog.querySelector('[data-deny]').onclick = deny;
  dialog.addEventListener('cancel', deny);
  signal?.addEventListener('abort', cancel, {once:true});
  pending = ticket;
  try{dialog.showModal();}catch(error){finish(false,error);}
 });
}

export async function requireApproval(approve, request, signal) {
 signal?.throwIfAborted();
 if (!approve || await approve(Object.freeze({...request}), signal) !== true) {
  throw new Error('Action denied. No changes were made. Do not retry it without a new user request.');
 }
 signal?.throwIfAborted();
}
