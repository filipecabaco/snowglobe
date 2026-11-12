// This catalog is the contract between detection, the UI, and the guest builder.
export const environments = Object.freeze([
  {id:'static', name:'Static site', detail:'HTML, CSS, JavaScript, and assets. No install or build step.', install:false, script:'', output:'.', base:false},
  {id:'react', name:'React + Vite', detail:'Install npm dependencies, then build a React frontend with Vite.', install:true, script:'build', output:'dist', base:true},
  {id:'svelte', name:'Svelte + Vite', detail:'Install npm dependencies, then build a Svelte frontend with Vite.', install:true, script:'build', output:'dist', base:true},
  {id:'vue', name:'Vue + Vite', detail:'Install npm dependencies, then build a Vue frontend with Vite.', install:true, script:'build', output:'dist', base:true},
  {id:'vite', name:'Vite', detail:'Build another Vite frontend, including vanilla JavaScript and TypeScript.', install:true, script:'build', output:'dist', base:true},
  {id:'cra', name:'Create React App', detail:'Build an existing react-scripts project with npm.', install:true, script:'build', output:'build', base:false},
  {id:'npm', name:'Other npm frontend', detail:'Run an npm script that produces a static site. Set its output folder below.', install:true, script:'build', output:'dist', base:false},
]);

export function environment(id) {
  const value = environments.find(item => item.id === id);
  if (!value) throw Error('Choose a supported environment.');
  return value;
}

export function relativePath(value, {dot = true} = {}) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '..' || (part === '.' && value !== '.'))) throw Error('Use a relative folder path without .. segments.');
  if (!dot && value === '.') throw Error('Choose a file path.');
  return value;
}

export function buildSettings(id, script, output) {
  const recipe = environment(id);
  if (recipe.install && !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(script)) throw Error('Enter an npm script name, such as build.');
  return {...recipe, script:recipe.install ? script : '', output:relativePath(output.trim())};
}
