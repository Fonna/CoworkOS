import { normalizeModel } from "./model.js";
import { normalizeProgram, type CadProgram } from "./program.js";
/** Preserve the complete existing design and expose its dimensions/transforms as source parameters. */
export function programFromModel(input: unknown): CadProgram {
  const model = normalizeModel(input);
  const source = `const { primitives, transforms, booleans } = require('@jscad/modeling');
const parts = ${JSON.stringify(model.parts, null, 2)};
function getParameterDefinitions() {
  return parts.flatMap((p,index) => {
    const values = p.shape === 'box' ? p.size.map((v,i) => ['size'+i,v]) : [['radius',p.radius], ...(p.shape === 'cylinder' ? [['height',p.height]] : [])];
    values.push(...p.position.map((v,i) => ['position'+i,v]), ...p.rotation.map((v,i) => ['rotation'+i,v]));
    return values.map(([field,initial]) => ({name:'part'+index+'_'+field,type:'float',initial,caption:p.name+' · '+field}));
  });
}
function main(params) {
  let result;
  for (const [index,original] of parts.entries()) {
    const p = JSON.parse(JSON.stringify(original));
    for (const field of ['radius','height']) p[field] = params['part'+index+'_'+field] ?? p[field];
    for (const field of ['size','position','rotation']) p[field] = p[field].map((v,i) => params['part'+index+'_'+field+i] ?? v);
    let g = p.shape === 'box' ? primitives.cuboid({size:p.size}) : p.shape === 'cylinder' ? primitives.cylinder({radius:p.radius,height:p.height,segments:32}) : primitives.sphere({radius:p.radius,segments:32});
    g = transforms.translate(p.position, transforms.rotate(p.rotation.map(v=>v*Math.PI/180),g));
    result = p.mode === 'cut' ? booleans.subtract(result,g) : result ? booleans.union(result,g) : g;
  }
  return result ? [result] : [];
}
module.exports = {main,getParameterDefinitions};
`;
  return normalizeProgram({ version: 2, engine: "jscad", units: "mm", source, parameters: {} });
}
