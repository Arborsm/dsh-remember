import assert from 'node:assert'
import { TYPERT } from '../src/typert.ts'

// The typert loader validates this shape before registering the manifest; a
// failure here would only surface at host start, so pin the contract.

assert.equal(TYPERT.package, 'dsh-remember')
assert.equal(TYPERT.face, 'host')
assert.ok(Array.isArray(TYPERT.schemas))
assert.ok(Array.isArray(TYPERT.invocations) && TYPERT.invocations.length > 0)

const isStrictCodec = (codec) => {
  assert.equal(codec.mode, 'strict')
  assert.match(codec.typeSymbol, /^dsh-remember#/)
  assert.equal(typeof codec.create, 'function')
  assert.equal(typeof codec.create().parse, 'function')
}

for (const invocation of TYPERT.invocations) {
  assert.equal(invocation.id, `dsh-remember#memory/${invocation.method}`)
  assert.equal(invocation.service, 'memory')
  assert.equal(invocation.namespace, 'memory')
  assert.deepEqual(invocation.invocation, { kind: 'direct' })
  assert.equal(typeof invocation.method, 'string')
  assert.ok(Array.isArray(invocation.parameters))
  const wires = new Set()
  for (const parameter of invocation.parameters) {
    assert.equal(typeof parameter.name, 'string')
    assert.equal(parameter.wire, parameter.name)
    assert.equal(parameter.source, 'json')
    assert.ok(!wires.has(parameter.wire), `duplicate wire ${parameter.wire}`)
    wires.add(parameter.wire)
    isStrictCodec(parameter.codec)
  }
  isStrictCodec(invocation.result)
}

assert.ok(TYPERT.model.services.length > 0)
for (const service of TYPERT.model.services) {
  assert.equal(service.key, 'memory')
  assert.equal(typeof service.exportName, 'string')
  assert.ok(Array.isArray(service.members))
  assert.ok(Array.isArray(service.types))
}

// Optional request fields must be omitted, not set to undefined: the gateway
// JSON-checks the parsed value and an own undefined property fails the call.
const runCommand = TYPERT.invocations.find((invocation) => invocation.method === 'runCommand')
const parsed = runCommand.parameters[0].codec.create().parse({ action: 'refresh-view' })
assert.deepEqual(Object.keys(parsed).sort(), ['action', 'force'])
assert.deepEqual(
  Object.keys(runCommand.parameters[0].codec.create().parse({ action: 'import', payload: 'abc' })).sort(),
  ['action', 'force', 'payload'],
)
