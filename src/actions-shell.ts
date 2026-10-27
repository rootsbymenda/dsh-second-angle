/** Small static shell lexer, not an interpreter. Quoted examples are not commands. */
import { posix } from 'node:path'

export interface ShellCommand {
  readonly program: string
  readonly args: readonly string[]
  readonly order: number
  /** Argument indexes emitted as operators by the lexer, never quoted argument text. */
  readonly redirections: readonly number[]
  readonly stdin?: string
  /** A literal script written earlier in this same request. Never read from disk. */
  readonly script?: string
  readonly environment?: readonly string[]
  readonly variables?: readonly { name: string; operator: string }[]
}

const wrappers = new Set(['sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'setsid', 'xargs'])
const shellNames = new Set(['sh', 'bash', 'dash', 'zsh', 'source', '.'])
const stdinPaths = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
const assignment = /^[A-Za-z_]\w*=/

/** Whether an interpreter consumes stdin as its program, rather than as script data. */
export function readsScriptFromStdin(args: readonly string[], redirections: readonly number[], shell = false): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (redirections.includes(i)) { i++; continue }
    if (shell && ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(arg)) { i++; continue }
    if (stdinPaths.has(arg)) return true
    if (['-m', '-c', '-e', '--eval', '--print', '-p'].includes(arg)) return false
    if (!arg.startsWith('-') && !(shell && arg.startsWith('+'))) return false
  }
  return true
}

/** Interpreter validation options apply before the script operand, not to its arguments. */
export function syntaxOnly(command: ShellCommand): boolean {
  const { program, args, redirections } = command
  if (!['sh', 'bash', 'dash', 'zsh', 'node'].includes(program)) return false
  let noexec = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (redirections.includes(i)) { i++; continue }
    if (arg === '--' || arg === '-' || !/^[+-]/.test(arg)) break
    if (program === 'node') {
      if (arg === '--check' || arg === '-c') noexec = true
      if (['-e', '--eval', '-p', '--print'].includes(arg)) break
      if (['-r', '--require', '--import', '--input-type'].includes(arg)) i++
    } else {
      if (/^[-+][^-]*n/.test(arg)) noexec = arg[0] === '-'
      if (['-o', '+o'].includes(arg)) { if (args[++i] === 'noexec') noexec = arg[0] === '-'; continue }
      if (['--rcfile', '--init-file', '-O', '+O'].includes(arg)) { i++; continue }
      if (/^-[^-]*c/.test(arg)) break
    }
  }
  return noexec
}

interface ParsedShell { commands: ShellCommand[]; output?: string }
interface Expansion extends ParsedShell { end: number }

/** End is exclusive. A failed match consumes the suffix once, avoiding quadratic rescans. */
function parenthesisEnd(source: string, start: number): number {
  let level = 1
  let quote = ''
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]
    if (char === '\\' && quote !== "'") { i++; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') level++
    if (char === ')' && --level === 0) return i + 1
  }
  return -1
}

function expansion(source: string, start: number, depth: number): Expansion | undefined {
  if (source[start] === '$' && source[start + 1] === '(') {
    const end = parenthesisEnd(source, start + 1)
    if (end < 0) return { end: source.length, commands: [] }
    if (source[start + 2] === '(') return { end, commands: expandDocument(source.slice(start + 3, end - 2), depth), output: '$ARITHMETIC' }
    return { end, ...parseShell(source.slice(start + 2, end - 1), depth + 1) }
  }
  if (source[start] === '`') {
    let end = start + 1
    while (end < source.length) {
      if (source[end] === '\\') { end += 2; continue }
      if (source[end] === '`') break
      end++
    }
    if (end >= source.length) return { end, commands: [] }
    return { end: end + 1, ...parseShell(source.slice(start + 1, end), depth + 1) }
  }
  return undefined
}

/** Quotes inside an unquoted-delimiter heredoc do not suppress substitutions. */
function expandDocument(source: string, depth: number): ShellCommand[] {
  const commands: ShellCommand[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue }
    const result = expansion(source, i, depth)
    if (result) { commands.push(...result.commands); i = result.end - 1 }
  }
  return commands
}

function operands(args: readonly string[], redirections: readonly number[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (redirections.includes(i)) { i++; continue }
    if (!arg.startsWith('-') || arg === '-') result.push(arg)
  }
  return result
}

function parseShell(source: string, depth: number): ParsedShell {
  if (depth > 4) throw new Error('shell nesting exceeds inspection limit')
  interface HereDocument { delimiter: string; quoted: boolean; stripTabs: boolean; body: string }
  const segments: { words: string[]; redirections: number[]; order: number; pipeline: number; documents: HereDocument[]; variables: { name: string; operator: string }[] }[] = []
  const pendingDocuments: HereDocument[] = []
  let documents: HereDocument[] = []
  let delimiter: { stripTabs: boolean } | undefined
  const nested: ShellCommand[] = []
  let words: string[] = []
  let variables: { name: string; operator: string }[] = []
  let redirections: number[] = []
  let word = ''
  let quote = ''
  let quoted = false
  let started = false
  let order = 0
  let pipeline = 0
  const flushWord = (): void => {
    if (started) words.push(word)
    if (started && delimiter) {
      const document = { delimiter: word, quoted, stripTabs: delimiter.stripTabs, body: '' }
      documents.push(document); pendingDocuments.push(document); delimiter = undefined
    }
    word = ''; started = false; quoted = false
  }
  const flushSegment = (): void => {
    flushWord()
    if (words.length > 0) segments.push({ words, redirections, order, pipeline, documents, variables })
    words = []; redirections = []; documents = []; variables = []
  }
  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? ''
    if (quote !== "'" && !delimiter) {
      if (char === '$') {
        const variable = /^\$(?:\{(#?)([A-Za-z_]\w*)(:?[-+?=]|[#%]{1,2}|:)?|([A-Za-z_]\w*))/.exec(source.slice(i))
        const name = variable?.[2] ?? variable?.[4]
        if (name) variables.push({ name, operator: variable?.[1] || variable?.[3] || '' })
      }
      const result = expansion(source, i, depth)
      if (result) {
        nested.push(...result.commands.map(cmd => ({ ...cmd, order: i })))
        word += result.output ?? '$SUBSTITUTION'; started = true; i = result.end - 1; continue
      }
    }
    if (char === '\\' && quote !== "'") {
      const next = source[++i] ?? ''
      if (next !== '\n') { word += next; started = true; quoted = true }
      continue
    }
    if (quote) { if (char === quote) quote = ''; else word += char; continue }
    if (char === '"' || char === "'") { quote = char; started = true; quoted = true; continue }
    if (char === '#' && !started) {
      while (i < source.length && source[i] !== '\n') i++
      i--; continue
    }
    if (char === '(' && source[i + 1] === '(') {
      flushSegment()
      const end = parenthesisEnd(source, i)
      if (end < 0) break
      nested.push(...expandDocument(source.slice(i + 2, end - 2), depth).map(cmd => ({ ...cmd, order: i })))
      i = end - 1; continue
    }
    if (char === '\n') {
      flushSegment()
      let cursor = i + 1
      for (const document of pendingDocuments.splice(0)) {
        const body: string[] = []
        while (cursor < source.length) {
          const end = source.indexOf('\n', cursor)
          const next = end < 0 ? source.length : end + 1
          const line = source.slice(cursor, end < 0 ? undefined : end)
          const text = document.stripTabs ? line.replace(/^\t+/, '') : line
          cursor = next
          if (text === document.delimiter) break
          body.push(text)
        }
        document.body = body.join('\n')
        if (!document.quoted) nested.push(...expandDocument(document.body, depth).map(cmd => ({ ...cmd, order: i })))
      }
      i = cursor - 1; order = cursor; pipeline++; continue
    }
    if (';|&()'.includes(char)) {
      flushSegment()
      if (char !== '|' || source[i + 1] === '|' || source[i - 1] === '|') pipeline++
      order = i + 1; continue
    }
    if (char === '>' || char === '<') {
      flushWord()
      let operator = char
      if (source[i + 1] === char) { operator += char; i++ }
      if (operator === '<<' && source[i + 1] !== '<') {
        const stripTabs = source[i + 1] === '-'
        if (stripTabs) { operator += '-'; i++ }
        delimiter = { stripTabs }
      } else if (operator === '<<') { operator += '<'; i++ }
      redirections.push(words.length); words.push(operator); continue
    }
    if (/\s/.test(char)) { flushWord(); continue }
    word += char; started = true
  }
  flushSegment()
  const commands: ShellCommand[] = [...nested]
  const files = new Map<string, string>()
  const pipes = new Map<number, string | undefined>()
  const environment = new Map<string, string>()
  let output: string | undefined
  for (const segment of segments) {
    const tokens = segment.words
    const localEnvironment = new Map(environment)
    const assign = (value: string): void => { localEnvironment.set(value.split('=')[0] ?? '', value) }
    let at = 0
    while (at < tokens.length) {
      const value = tokens[at] ?? ''
      const base = value.split('/').at(-1) ?? value
      if (assignment.test(value)) { assign(value); at++; continue }
      if (['then', 'do', 'else', '!', 'if', 'while'].includes(value)) { at++; continue }
      if (base === 'env') {
        let commandAt = at + 1
        while (tokens[commandAt]?.startsWith('-') || assignment.test(tokens[commandAt] ?? '')) {
          const option = tokens[commandAt++] ?? ''
          if (assignment.test(option)) assign(option)
          if (['-i', '--ignore-environment'].includes(option)) localEnvironment.clear()
          if (['-u', '--unset'].includes(option)) localEnvironment.delete(tokens[commandAt++] ?? '')
          else if (option.startsWith('--unset=')) localEnvironment.delete(option.slice(8))
          else if (['-C', '--chdir'].includes(option)) commandAt++
        }
        if (tokens[commandAt] && !segment.redirections.includes(commandAt)) { at = commandAt; continue }
      }
      if (base === 'timeout') {
        at++
        while (tokens[at]?.startsWith('-')) at++
        if (/^\d/.test(tokens[at] ?? '')) at++
        continue
      }
      if (wrappers.has(base)) {
        if (base === 'command' && ['-v', '-V'].includes(tokens[at + 1] ?? '')) break
        at++
        while (tokens[at]?.startsWith('-')) {
          const option = tokens[at++]
          if (['-u', '-g', '-n', '-P', '-I', '--user', '--group'].includes(option ?? '')) at++
        }
        continue
      }
      break
    }
    const executable = tokens[at] ?? ''
    const program = executable.split('/').at(-1) ?? ''
    if (!program) {
      for (const [name, value] of localEnvironment) environment.set(name, value)
      continue
    }
    const args = tokens.slice(at + 1)
    const operators = segment.redirections.filter(index => index > at).map(index => index - at - 1)
    if (program === 'export') for (const value of args.filter(arg => assignment.test(arg))) environment.set(value.split('=')[0] ?? '', value)
    if (program === 'unset' && !args.includes('-f')) for (const name of args.filter(arg => !arg.startsWith('-'))) environment.delete(name)
    let stdin = pipes.get(segment.pipeline)
    for (let i = 0; i < args.length; i++) {
      if (!operators.includes(i)) continue
      const arg = args[i]
      if (arg === '<<<') stdin = args[++i]
      else if (arg === '<') stdin = files.get(posix.normalize(args[++i] ?? ''))
      else if (arg === '<<' || arg === '<<-') { stdin = segment.documents.at(-1)?.body; i++ }
    }
    const paths = operands(args, operators)
    const interpreter = shellNames.has(program) || /^(?:python[\d.]*|node|ruby|perl|php)$/.test(program)
    const script = files.get(posix.normalize(interpreter ? paths[0] ?? '' : executable))
    const command: ShellCommand = { program, args, redirections: operators, order: segment.order, ...stdin === undefined ? {} : { stdin }, ...script === undefined ? {} : { script }, ...localEnvironment.size ? { environment: [...localEnvironment.values()] } : {}, ...segment.variables.length ? { variables: segment.variables } : {} }
    commands.push(command)
    let body: string | undefined
    if (shellNames.has(program) && !syntaxOnly(command)) {
      const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg))
      body = flag >= 0 ? args[flag + 1] : script ?? (args.some(arg => /^-[^-]*s/.test(arg)) || readsScriptFromStdin(args, operators, true) ? stdin : undefined)
    } else if (program === 'eval') body = args.join(' ')
    else if (!interpreter && script !== undefined) body = script
    if (body !== undefined) commands.push(...parseShell(body, depth + 1).commands.map(cmd => ({ ...cmd, order: segment.order + cmd.order / (body.length + 1) })))

    // Propagate only literal cat/tee content, never arbitrary program output.
    output = program === 'tee' || (program === 'cat' && paths.every(path => path === '-')) ? stdin : undefined
    if (program === 'tee') for (const path of paths) {
      if (output !== undefined) files.set(posix.normalize(path), output)
      else files.delete(posix.normalize(path))
    }
    for (let i = 0; i < args.length; i++) if (operators.includes(i) && (args[i] === '>' || args[i] === '>>')) {
      const append = args[i] === '>>'
      const path = posix.normalize(args[++i] ?? '')
      if (output !== undefined) files.set(path, append ? `${files.get(path) ?? ''}\n${output}` : output)
      else files.delete(path)
      output = undefined
    }
    pipes.set(segment.pipeline, output)
  }
  return { commands: commands.sort((a, b) => a.order - b.order), ...output === undefined ? {} : { output } }
}

/** Extract executed commands and literal scripts, bounded by nesting depth. */
export function shellCommands(source: string, depth = 0): ShellCommand[] {
  return parseShell(source, depth).commands
}
