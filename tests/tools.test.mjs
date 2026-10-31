import assert from 'node:assert'
import { registerTransferTools } from '../src/transfer.ts'

// The host forwards `parameters` to the model verbatim and only validates
// `output.schema`, so a bare property map reaches the provider as
// `type: null` and fails every request. Pin the object root and the wire
// arguments here instead of discovering it in a bug report.

const registered = []
const tools = { register: (definition) => registered.push(definition) }

registerTransferTools(tools, {}, { workspaceRoot: 'E:/memories' })

assert.equal(registered.length, 2)
const byName = new Map(registered.map((definition) => [definition.name, definition]))
assert.deepEqual([...byName.keys()].sort(), ['memory_export', 'memory_import'])

for (const [name, argument] of [
  ['memory_export', 'destPath'],
  ['memory_import', 'srcPath'],
]) {
  const definition = byName.get(name)
  assert.equal(typeof definition.description, 'string')
  assert.deepEqual(definition.parameters.type, 'object', `${name} parameters need an object root`)
  assert.deepEqual(Object.keys(definition.parameters.properties), [argument])
  assert.equal(definition.parameters.properties[argument].type, 'string')
  assert.deepEqual(definition.parameters.required, [argument])
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.output.schema, { type: 'string' })
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.execute, 'function')
}
