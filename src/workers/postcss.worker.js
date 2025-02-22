import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  doComplete,
  resolveCompletionItem,
  doValidate,
  doHover,
  getDocumentColors,
  completionsFromClassList,
} from 'tailwindcss-language-service'
import {
  asCompletionResult as asMonacoCompletionResult,
  asCompletionItem as asMonacoCompletionItem,
  asDiagnostics as asMonacoDiagnostics,
  asHover as asMonacoHover,
  asRange as asMonacoRange,
} from '../monaco/lspToMonaco'
import {
  asCompletionItem as asLspCompletionItem,
  asRange as asLspRange,
} from '../monaco/monacoToLsp'
import CompileWorker from 'worker-loader?publicPath=/_next/&filename=static/chunks/[name].[hash].js&chunkFilename=static/chunks/[id].[contenthash].worker.js!./compile.worker.js'
import { createWorkerQueue } from '../utils/workers'
import './subworkers'
import { getVariants } from '../utils/getVariants'
import { parseConfig } from './parseConfig'
import { toValidTailwindVersion } from '../utils/toValidTailwindVersion'
import { isObject } from '../utils/object'

const compileWorker = createWorkerQueue(CompileWorker)

let state

addEventListener('message', async (event) => {
  if (event.data.lsp) {
    let result

    function fallback(fn, fallbackValue) {
      if (!state || !state.enabled) return fallbackValue
      return fn()
    }

    const document = TextDocument.create(
      event.data.lsp.uri,
      event.data.lsp.language,
      1,
      event.data.lsp.text
    )

    switch (event.data.lsp.type) {
      case 'complete':
        result = await fallback(
          async () =>
            asMonacoCompletionResult(
              await doComplete(state, document, {
                line: event.data.lsp.position.lineNumber - 1,
                character: event.data.lsp.position.column - 1,
              })
            ),
          []
        )
        break
      case 'completeString':
        result = fallback(() =>
          asMonacoCompletionResult(
            completionsFromClassList(
              state,
              document.getText(),
              asLspRange(event.data.lsp.range)
            )
          )
        )
        break
      case 'resolveCompletionItem':
        result = await fallback(async () =>
          asMonacoCompletionItem(
            await resolveCompletionItem(
              state,
              asLspCompletionItem(event.data.lsp.item)
            )
          )
        )
        break
      case 'hover':
        result = await fallback(async () => {
          const hover = await doHover(state, document, {
            line: event.data.lsp.position.lineNumber - 1,
            character: event.data.lsp.position.column - 1,
          })
          if (hover && hover.contents.language === 'css') {
            hover.contents.language = 'tailwindcss'
          }
          return asMonacoHover(hover)
        })
        break
      case 'validate':
        result = await fallback(
          async () => asMonacoDiagnostics(await doValidate(state, document)),
          []
        )
        break
      case 'documentColors':
        result = await fallback(
          async () =>
            (await getDocumentColors(state, document)).map(
              ({ color, range }) => ({
                range: asMonacoRange(range),
                color,
              })
            ),
          []
        )
        break
    }

    return postMessage({ _id: event.data._id, result })
  }

  if (
    (typeof event.data.css !== 'undefined' &&
      typeof event.data.config !== 'undefined' &&
      typeof event.data.html !== 'undefined') ||
    event.data._recompile
  ) {
    const result = await compileWorker.emit(event.data)

    if (!result.error && !result.canceled) {
      if ('buildId' in result) {
        self.BUILD_ID = result.buildId
      }
      if (result.state) {
        let tailwindVersion = toValidTailwindVersion(event.data.tailwindVersion)
        let [
          { default: postcss },
          { default: postcssSelectorParser },
          { generateRules },
          { createContext },
          { default: expandApplyAtRules },
          { default: resolveConfig },
        ] = await Promise.all([
          import('postcss'),
          import('postcss-selector-parser'),
          result.state.jit
            ? import('tailwindcss/lib/jit/lib/generateRules')
            : {},
          result.state.jit
            ? import('tailwindcss/lib/jit/lib/setupContextUtils')
            : {},
          result.state.jit
            ? import('tailwindcss/lib/jit/lib/expandApplyAtRules')
            : {},
          tailwindVersion === '2'
            ? import('tailwindcss/resolveConfig')
            : import('tailwindcss-v1/resolveConfig'),
          result.state.jit
            ? import('tailwindcss/lib/jit/lib/setupTrackingContext')
            : {},
        ])

        state = result.state
        state.modules = {
          postcss: { module: postcss },
          postcssSelectorParser: { module: postcssSelectorParser },
          ...(result.state.jit
            ? {
                jit: {
                  generateRules: {
                    module: generateRules,
                  },
                  expandApplyAtRules: {
                    module: expandApplyAtRules,
                  },
                },
              }
            : {}),
        }
        let config = await parseConfig(event.data.config, tailwindVersion)
        state.config = resolveConfig(config)
        if (result.state.jit) {
          state.jitContext = createContext(state.config)
        }
      }
      state.variants = getVariants(state)
      state.screens = isObject(state.config.screens)
        ? Object.keys(state.config.screens)
        : []
      state.editor.getConfiguration = () => ({
        editor: {
          tabSize: 2,
        },
        tailwindCSS: {
          validate: true,
          lint: {
            cssConflict: 'warning',
            invalidApply: 'error',
            invalidScreen: 'error',
            invalidVariant: 'error',
            invalidConfigPath: 'error',
            invalidTailwindDirective: 'error',
            recommendedVariantOrder: 'warning',
          },
        },
      })
      state.enabled = true
      postMessage({
        _id: event.data._id,
        css: result.css,
        html: result.html,
        jit: result.jit,
      })
    } else {
      postMessage({ ...result, _id: event.data._id })
    }
  }
})
