const resolvedKinds = ['signedOut', 'unavailable']

function sessionBinding(statements) {
  for (const statement of statements) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const { id, init } of statement.declarations) {
      if (id.type !== 'ArrayPattern' || init?.type !== 'CallExpression') continue
      const initialState = init.arguments[0]
      if (initialState?.type === 'ObjectExpression' && initialState.properties.some(
        property => property.type === 'Property' && property.key.name === 'kind' &&
          property.value.value === 'loading',
      )) return id.elements[0]?.name
    }
  }
}

function sessionKindComparison(node, binding) {
  if (node.type !== 'BinaryExpression' || !['===', '!=='].includes(node.operator)) return null
  for (const [member, value] of [[node.left, node.right], [node.right, node.left]]) {
    if (
      member.type === 'MemberExpression' && !member.computed &&
      member.object.type === 'Identifier' && member.object.name === binding &&
      member.property.name === 'kind' && typeof value.value === 'string'
    ) return { kind: value.value, equal: node.operator === '===' }
  }
  return null
}

function canMatchKind(node, kind, binding) {
  const comparison = sessionKindComparison(node, binding)
  if (comparison) return (comparison.kind === kind) === comparison.equal
  if (node.type === 'LogicalExpression' && node.operator === '&&') {
    return canMatchKind(node.left, kind, binding) && canMatchKind(node.right, kind, binding)
  }
  if (node.type === 'LogicalExpression' && node.operator === '||') {
    return canMatchKind(node.left, kind, binding) || canMatchKind(node.right, kind, binding)
  }
  return true
}

function returns(statement) {
  return statement.type === 'ReturnStatement' ||
    (statement.type === 'BlockStatement' && statement.body.at(-1)?.type === 'ReturnStatement')
}

export default {
  meta: { name: 'admin-session' },
  rules: {
    'resolved-before-readiness': {
      meta: {
        schema: [],
        messages: {
          earlyReturn: 'Handle session state {{kind}} before another render branch can return.',
        },
      },
      create(context) {
        return {
          FunctionDeclaration(node) {
            if (node.id?.name !== 'ShellRoute' || !node.body) return
            const binding = sessionBinding(node.body.body)
            if (!binding) return
            const handled = new Set()
            // Inspect the shell's sequential render guards. A loading-only guard
            // can return early because neither resolved state can match it.
            for (const statement of node.body.body) {
              if (statement.type !== 'IfStatement' || !returns(statement.consequent)) continue
              const comparison = sessionKindComparison(statement.test, binding)
              if (comparison?.equal && resolvedKinds.includes(comparison.kind)) {
                handled.add(comparison.kind)
                continue
              }
              const blocked = resolvedKinds.filter(
                kind => !handled.has(kind) && canMatchKind(statement.test, kind, binding),
              )
              if (blocked.length) {
                context.report({
                  node: statement.test,
                  messageId: 'earlyReturn',
                  data: { kind: blocked.join(' or ') },
                })
              }
            }
          },
        }
      },
    },
  },
}
