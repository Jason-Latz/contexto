export const meta = {
  name: 'args-probe',
  description: 'Zero-agent probe: report how args arrive',
}
const t = typeof args
let A = {}
if (t === 'string') { try { A = JSON.parse(args) } catch { A = { parseError: true } } }
else if (t !== 'undefined' && args) { A = args }
log(`typeof args = ${t}`)
return { typeofArgs: t, resolved: A, maxBatchesType: typeof A.maxBatches, maxBatches: A.maxBatches }
