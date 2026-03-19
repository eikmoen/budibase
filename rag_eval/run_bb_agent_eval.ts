import { AIConfigType } from "@budibase/types"
import { spawnSync } from "child_process"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "path"
import * as dotenv from "dotenv"

interface CsvRow {
  [key: string]: string
}

interface QuestionRow {
  rowId: string
  question: string
  reference: string
}

interface ResponseRow {
  row_id: string
  question: string
  reference: string
  response: string
  source_hints: string
}

interface ChatConversationMessage {
  role: string
  parts?: Array<{ type: string; text?: string }>
  metadata?: {
    ragSources?: Array<{ filename?: string; sourceId?: string }>
  }
}

interface ChatConversation {
  messages: ChatConversationMessage[]
}

interface UploadedFile {
  filename: string
  status: "processing" | "ready" | "failed"
  errorMessage?: string
}

interface CreatedResources {
  completionConfigId?: string
  completionConfigCreated?: boolean
  embeddingConfigId?: string
  embeddingConfigCreated?: boolean
  vectorDbId?: string
  vectorDbCreated?: boolean
  knowledgeBaseId?: string
  knowledgeBaseCreated?: boolean
  agentId?: string
  agentCreated?: boolean
}

interface RuntimeEnv {
  budibaseBaseUrl: string
  appId: string
  budibaseUsername: string
  budibasePassword: string
  provider: string
  openAIKey: string
  openAIBaseUrl: string
  chatModel: string
  embeddingModel: string
  vectorDbHost: string
  vectorDbPort: number
  vectorDbDatabase: string
  vectorDbUser: string
  vectorDbPassword: string
  completionConfigName: string
  embeddingConfigName: string
  vectorDbName: string
  knowledgeBaseName: string
  agentName: string
  keepResources: boolean
  documents: string[]
  ragasMinContextPrecision?: number
  ragasMinContextRecall?: number
  ragasMinFaithfulness?: number
  ragasMinAnswerRelevancy?: number
  ragasMinAnswerCorrectness?: number
  ragasThreshold?: number
}

interface RagasSample {
  caseId: string
  question: string
  answer: string
  contexts: string[]
  reference?: string
  sourceHints: string[]
}

interface RagasOutput {
  aggregate?: Record<string, number>
  byCase?: Array<Record<string, unknown>>
  raw?: unknown
}

function nowTimestamp() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function resolvePath(rootDir: string, candidate: string) {
  if (isAbsolute(candidate)) {
    return candidate
  }
  return resolve(rootDir, candidate)
}

function loadEnvFile(rootDir: string) {
  const configured = process.env.RAG_EVAL_ENV_FILE?.trim()
  const candidates = configured
    ? [resolvePath(rootDir, configured)]
    : [join(rootDir, ".env"), join(rootDir, "ragas", ".env")]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    dotenv.config({ path: candidate })
    console.log(`Loaded env: ${candidate}`)
    return
  }

  if (configured) {
    throw new Error(`RAG_EVAL_ENV_FILE not found: ${candidates[0]}`)
  }
}

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

function parseOptionalNumber(name: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  return parsed
}

function parseArgs(argv: string[]) {
  const defaults = {
    inputCsv: "ragas/evals/datasets/testset.csv",
    responsesCsv: `ragas/evals/experiments/agent_responses_${nowTimestamp()}.csv`,
    scoresJson: `ragas/evals/experiments/ragas_scores_${nowTimestamp()}.json`,
  }

  const result = { ...defaults }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--input-csv") {
      result.inputCsv = argv[i + 1]
      i += 1
    } else if (arg === "--responses-csv") {
      result.responsesCsv = argv[i + 1]
      i += 1
    } else if (arg === "--scores-json" || arg === "--scores-csv") {
      result.scoresJson = argv[i + 1]
      i += 1
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: run_bb_agent_eval.ts [--input-csv path] [--responses-csv path] [--scores-json path]",
          "",
          "Defaults:",
          `  --input-csv ${defaults.inputCsv}`,
          `  --responses-csv ${defaults.responsesCsv}`,
          `  --scores-json ${defaults.scoresJson}`,
        ].join("\n")
      )
      process.exit(0)
    }
  }
  return result
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ""
  let inQuotes = false

  const pushField = () => {
    currentRow.push(currentField)
    currentField = ""
  }
  const pushRow = () => {
    rows.push(currentRow)
    currentRow = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (inQuotes) {
      if (char === '"' && next === '"') {
        currentField += '"'
        i += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        currentField += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ",") {
      pushField()
    } else if (char === "\n") {
      pushField()
      pushRow()
    } else if (char === "\r") {
      // Ignore CR in CRLF.
    } else {
      currentField += char
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushField()
    pushRow()
  }

  if (rows.length === 0) {
    return []
  }

  const headers = rows[0]
  return rows.slice(1).map(row => {
    const record: CsvRow = {}
    headers.forEach((header, index) => {
      record[header] = row[index] || ""
    })
    return record
  })
}

function escapeCsv(value: string) {
  const escaped = value.replace(/"/g, '""')
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped}"`
  }
  return escaped
}

function toCsv(rows: Array<Record<string, string>>) {
  if (rows.length === 0) {
    return ""
  }
  const headers = Object.keys(rows[0])
  const lines = [headers.map(escapeCsv).join(",")]
  for (const row of rows) {
    lines.push(headers.map(header => escapeCsv(row[header] ?? "")).join(","))
  }
  return `${lines.join("\n")}\n`
}

function loadQuestions(inputCsvPath: string): QuestionRow[] {
  const raw = readFileSync(inputCsvPath, "utf-8")
  const parsed = parseCsv(raw)
  const questions: QuestionRow[] = []

  parsed.forEach((row, index) => {
    const question = (row.user_input || row.question || "").trim()
    if (!question) {
      return
    }
    questions.push({
      rowId: String(index + 1),
      question,
      reference: (row.reference || "").trim(),
    })
  })

  return questions
}

function getMimeType(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith(".pdf")) {
    return "application/pdf"
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text/markdown"
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "application/x-yaml"
  }
  return "text/plain"
}

function wait(ms: number) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

class ApiClient {
  private token = ""
  private appId = ""
  private csrfToken = ""
  private baseUrl: string

  constructor(
    baseUrl: string,
    private targetAppId: string,
    private username: string,
    private password: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "")
  }

  async init() {
    const loginResponse = await fetch(
      `${this.baseUrl}/api/global/auth/default/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
        }),
      }
    )
    if (!loginResponse.ok) {
      const body = await loginResponse.text()
      throw new Error(`Login failed (${loginResponse.status}): ${body}`)
    }

    const token =
      loginResponse.headers.get("x-budibase-token") ||
      loginResponse.headers.get("token")
    if (!token) {
      throw new Error("No auth token returned by login endpoint")
    }
    this.token = token

    const apps = await this.request<Array<{ appId?: string; _id?: string }>>(
      "GET",
      "/api/applications?status=all",
      undefined,
      false
    )
    const appIds = apps.map(app => app.appId || app._id).filter(Boolean)
    if (!appIds.includes(this.targetAppId)) {
      throw new Error(
        `Configured app ${this.targetAppId} was not found. Available apps: ${appIds.join(", ")}`
      )
    }
    this.appId = this.targetAppId

    const self = await this.request<{ csrfToken?: string }>(
      "GET",
      "/api/self",
      undefined,
      true
    )
    if (!self.csrfToken) {
      throw new Error("Unable to resolve csrfToken from /api/self")
    }
    this.csrfToken = self.csrfToken
  }

  clearSession() {
    this.token = ""
    this.appId = ""
    this.csrfToken = ""
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    includeAppHeaders = true
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-budibase-token": this.token,
    }
    if (includeAppHeaders) {
      headers["x-budibase-app-id"] = this.appId
    }
    if (method !== "GET") {
      headers["x-csrf-token"] = this.csrfToken
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    let payload: any = {}
    if (text) {
      payload = JSON.parse(text)
    }
    if (!response.ok) {
      throw new Error(
        `${method} ${path} failed (${response.status}): ${text || "<empty>"}`
      )
    }
    return payload as T
  }

  async requestStream(path: string, body: unknown) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-budibase-token": this.token,
      "x-budibase-app-id": this.appId,
      "x-csrf-token": this.csrfToken,
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `POST ${path} failed (${response.status}): ${text || "<empty>"}`
      )
    }
    if (response.body) {
      await response.arrayBuffer()
    }
  }

  async uploadKnowledgeBaseFile(
    knowledgeBaseId: string,
    filename: string,
    content: Buffer,
    contentType: string
  ): Promise<UploadedFile> {
    const headers: Record<string, string> = {
      "x-budibase-token": this.token,
      "x-budibase-app-id": this.appId,
      "x-csrf-token": this.csrfToken,
    }
    const formData = new FormData()
    formData.append(
      "file",
      new Blob([content as any], { type: contentType }),
      filename
    )

    const response = await fetch(
      `${this.baseUrl}/api/knowledge-base/${knowledgeBaseId}/files`,
      {
        method: "POST",
        headers,
        body: formData,
      }
    )
    const text = await response.text()
    const payload = text ? JSON.parse(text) : {}
    if (!response.ok) {
      throw new Error(
        `POST /api/knowledge-base/${knowledgeBaseId}/files failed (${response.status}): ${text || "<empty>"}`
      )
    }
    if (!payload?.file) {
      throw new Error(`Unexpected upload response: ${text || "<empty>"}`)
    }
    return payload.file as UploadedFile
  }
}

function extractAssistantText(chat: ChatConversation) {
  const assistantMessages = (chat.messages || []).filter(
    message => message.role === "assistant"
  )
  const last = assistantMessages[assistantMessages.length - 1]
  if (!last?.parts) {
    return ""
  }
  return last.parts
    .filter(part => part.type === "text" && part.text)
    .map(part => part.text || "")
    .join("")
    .trim()
}

function extractRagSourceHints(chat: ChatConversation) {
  const assistantMessages = (chat.messages || []).filter(
    message => message.role === "assistant"
  )
  const last = assistantMessages[assistantMessages.length - 1]
  const ragSources = last?.metadata?.ragSources || []
  return ragSources
    .map(source => source.filename || source.sourceId || "")
    .filter(Boolean)
}

function findByName<T extends { name?: string }>(items: T[], name: string) {
  const normalized = name.trim().toLowerCase()
  return items.find(item => item.name?.trim().toLowerCase() === normalized)
}

function withSettingsSuffix(baseName: string, suffix: string) {
  return `${baseName} ${suffix}`
}

function shouldIgnoreAttachAgentError(error: unknown) {
  const rawMessage = (error as any)?.message
  const message = typeof rawMessage === "string" ? rawMessage.toLowerCase() : ""
  return (
    message.includes("already") &&
    (message.includes("agent") || message.includes("exists"))
  )
}

async function waitForKnowledgeBaseFilesReady(
  api: ApiClient,
  knowledgeBaseId: string,
  requiredFilenames: string[]
) {
  const timeoutMs = 180_000
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await api.request<{ files: UploadedFile[] }>(
      "GET",
      `/api/knowledge-base/${knowledgeBaseId}/files`
    )
    const files = result.files || []
    const requiredStatuses = requiredFilenames.map(filename => {
      const candidates = files.filter(file => file.filename === filename)
      return {
        filename,
        ready: candidates.some(file => file.status === "ready"),
        failed: candidates.filter(file => file.status === "failed"),
      }
    })

    const readyCount = requiredStatuses.filter(status => status.ready).length
    const failed = requiredStatuses.flatMap(status =>
      status.ready ? [] : status.failed
    )

    if (failed.length > 0) {
      const details = failed
        .map(
          file => `${file.filename}: ${file.errorMessage || "unknown error"}`
        )
        .join(", ")
      throw new Error(`Knowledge base file ingestion failed: ${details}`)
    }

    if (readyCount === requiredFilenames.length) {
      return
    }

    await wait(1500)
  }

  throw new Error(
    `Timed out waiting for knowledge base ingestion after ${timeoutMs}ms`
  )
}

async function cleanupResources(api: ApiClient, created: CreatedResources) {
  if (created.agentCreated && created.agentId) {
    try {
      await api.request("DELETE", `/api/agent/${created.agentId}`)
    } catch (error) {
      console.warn(
        `Cleanup warning (agent): ${(error as any)?.message || error}`
      )
    }
  }
  if (created.knowledgeBaseCreated && created.knowledgeBaseId) {
    try {
      await api.request(
        "DELETE",
        `/api/knowledge-base/${created.knowledgeBaseId}`
      )
    } catch (error) {
      console.warn(
        `Cleanup warning (knowledge base): ${(error as any)?.message || error}`
      )
    }
  }
  if (created.vectorDbCreated && created.vectorDbId) {
    try {
      await api.request("DELETE", `/api/vectordb/${created.vectorDbId}`)
    } catch (error) {
      console.warn(
        `Cleanup warning (vector DB): ${(error as any)?.message || error}`
      )
    }
  }
  if (created.embeddingConfigCreated && created.embeddingConfigId) {
    try {
      await api.request("DELETE", `/api/configs/${created.embeddingConfigId}`)
    } catch (error) {
      console.warn(
        `Cleanup warning (embedding config): ${(error as any)?.message || error}`
      )
    }
  }
  if (created.completionConfigCreated && created.completionConfigId) {
    try {
      await api.request("DELETE", `/api/configs/${created.completionConfigId}`)
    } catch (error) {
      console.warn(
        `Cleanup warning (completion config): ${(error as any)?.message || error}`
      )
    }
  }
}

function parseDocuments(input: string | undefined) {
  if (!input?.trim()) {
    return ["ragas/datasets/customer-support-operations-handbook.md"]
  }
  return input
    .split(",")
    .map(path => path.trim())
    .filter(Boolean)
}

function mean(numbers: number[]) {
  if (numbers.length === 0) {
    return 0
  }
  return numbers.reduce((acc, n) => acc + n, 0) / numbers.length
}

function evaluateMetricRails(
  runtimeEnv: RuntimeEnv,
  aggregate: Record<string, number>
) {
  const checks: Array<{ metricName: string; min?: number }> = [
    {
      metricName: "context_precision",
      min: runtimeEnv.ragasMinContextPrecision,
    },
    {
      metricName: "context_recall",
      min: runtimeEnv.ragasMinContextRecall,
    },
    {
      metricName: "faithfulness",
      min: runtimeEnv.ragasMinFaithfulness,
    },
    {
      metricName: "answer_relevancy",
      min: runtimeEnv.ragasMinAnswerRelevancy,
    },
    {
      metricName: "answer_correctness",
      min: runtimeEnv.ragasMinAnswerCorrectness,
    },
  ]

  const failures: string[] = []
  for (const check of checks) {
    if (typeof check.min !== "number") {
      continue
    }
    const value = aggregate[check.metricName]
    if (typeof value !== "number") {
      failures.push(
        `${check.metricName}: missing metric, expected >= ${check.min.toFixed(4)}`
      )
      continue
    }
    if (value < check.min) {
      failures.push(
        `${check.metricName}: ${value.toFixed(4)} < ${check.min.toFixed(4)}`
      )
    }
  }

  return failures
}

function runRagas(rootDir: string, runtimeEnv: RuntimeEnv, samples: RagasSample[], outputPath: string): RagasOutput {
  const runnerPath = resolve(
    rootDir,
    "../packages/server/scripts/rag-evals/ragas_runner.py"
  )
  if (!existsSync(runnerPath)) {
    throw new Error(`ragas_runner.py not found: ${runnerPath}`)
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const inputPath = join(dirname(outputPath), `ragas-input-${runId}.json`)
  writeFileSync(inputPath, JSON.stringify({ samples }, null, 2), "utf-8")

  const executed = spawnSync(
    "uv",
    ["run", "python", runnerPath, inputPath, outputPath],
    {
      cwd: join(rootDir, "ragas"),
      encoding: "utf-8",
      env: {
        ...process.env,
        OPENAI_API_KEY: runtimeEnv.openAIKey,
        OPENAI_BASE_URL: runtimeEnv.openAIBaseUrl,
        OPENAI_API_BASE: runtimeEnv.openAIBaseUrl,
      },
    }
  )
  if (executed.error) {
    throw executed.error
  }
  if (executed.status !== 0) {
    const stderr = executed.stderr?.trim() || "<empty>"
    const stdout = executed.stdout?.trim() || "<empty>"
    throw new Error(
      `RAGAS runner failed with code ${executed.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    )
  }
  if (!existsSync(outputPath)) {
    throw new Error("RAGAS runner did not create output file")
  }
  return JSON.parse(readFileSync(outputPath, "utf-8")) as RagasOutput
}

function getRuntimeEnv() {
  const vectorDbPortRaw = getRequiredEnv("RAG_EVAL_VECTORDB_PORT")
  const vectorDbPort = Number(vectorDbPortRaw)
  if (!Number.isInteger(vectorDbPort) || vectorDbPort <= 0) {
    throw new Error(
      `Invalid RAG_EVAL_VECTORDB_PORT: ${vectorDbPortRaw}. Must be a positive integer.`
    )
  }

  return {
    budibaseBaseUrl: getRequiredEnv("BUDIBASE_BASE_URL"),
    appId: getRequiredEnv("RAG_EVAL_APP_ID"),
    budibaseUsername: getRequiredEnv("BUDIBASE_USERNAME"),
    budibasePassword: getRequiredEnv("BUDIBASE_PASSWORD"),
    provider: getRequiredEnv("RAG_EVAL_PROVIDER"),
    openAIKey: getRequiredEnv("OPENAI_API_KEY"),
    openAIBaseUrl: getRequiredEnv("OPENAI_BASE_URL"),
    chatModel: process.env.CHAT_MODEL?.trim() || "gpt-4o-mini",
    embeddingModel:
      process.env.RAG_EVAL_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    vectorDbHost: getRequiredEnv("RAG_EVAL_VECTORDB_HOST"),
    vectorDbPort,
    vectorDbDatabase: getRequiredEnv("RAG_EVAL_VECTORDB_DATABASE"),
    vectorDbUser: getRequiredEnv("RAG_EVAL_VECTORDB_USER"),
    vectorDbPassword: getRequiredEnv("RAG_EVAL_VECTORDB_PASSWORD"),
    completionConfigName:
      process.env.RAG_EVAL_COMPLETION_CONFIG_NAME?.trim() ||
      "RAG Eval Completion",
    embeddingConfigName:
      process.env.RAG_EVAL_EMBEDDING_CONFIG_NAME?.trim() ||
      "RAG Eval Embedding",
    vectorDbName:
      process.env.RAG_EVAL_VECTORDB_NAME?.trim() || "RAG Eval Vector DB",
    knowledgeBaseName:
      process.env.RAG_EVAL_KB_NAME?.trim() || "RAG Eval Knowledge Base",
    agentName: process.env.RAG_EVAL_AGENT_NAME?.trim() || "RAG Eval Agent",
    keepResources: process.env.RAG_EVAL_KEEP_RESOURCES?.trim() === "1",
    documents: parseDocuments(process.env.RAG_EVAL_DOCUMENTS),
    ragasMinContextPrecision:
      parseOptionalNumber("RAG_EVAL_RAGAS_MIN_CONTEXT_PRECISION") || 0.75,
    ragasMinContextRecall:
      parseOptionalNumber("RAG_EVAL_RAGAS_MIN_CONTEXT_RECALL") || 0.9,
    ragasMinFaithfulness:
      parseOptionalNumber("RAG_EVAL_RAGAS_MIN_FAITHFULNESS") || 0.75,
    ragasMinAnswerRelevancy:
      parseOptionalNumber("RAG_EVAL_RAGAS_MIN_ANSWER_RELEVANCY") || 0.7,
    ragasMinAnswerCorrectness:
      parseOptionalNumber("RAG_EVAL_RAGAS_MIN_ANSWER_CORRECTNESS") || 0.7,
    ragasThreshold: parseOptionalNumber("RAG_EVAL_RAGAS_THRESHOLD"),
  } as RuntimeEnv
}

async function main() {
  const rootDir = __dirname
  loadEnvFile(rootDir)
  const args = parseArgs(process.argv.slice(2))
  const runtimeEnv = getRuntimeEnv()

  const inputCsv = resolvePath(rootDir, args.inputCsv)
  const responsesCsv = resolvePath(rootDir, args.responsesCsv)
  const scoresJson = resolvePath(rootDir, args.scoresJson)
  if (!existsSync(inputCsv)) {
    throw new Error(`Input CSV not found: ${inputCsv}`)
  }

  const documentPaths = runtimeEnv.documents.map(path =>
    resolvePath(rootDir, path)
  )
  if (documentPaths.length === 0) {
    throw new Error("No documents configured for upload")
  }
  for (const path of documentPaths) {
    if (!existsSync(path)) {
      throw new Error(`Document not found: ${path}`)
    }
  }

  const docSignatures = documentPaths
    .map(path => {
      const text = readFileSync(path).toString("utf-8")
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16)
      return `${path}:${hash}`
    })
    .sort((a, b) => a.localeCompare(b))
  const docTextByFilename = new Map<string, string>()
  for (const docPath of documentPaths) {
    const text = readFileSync(docPath).toString("utf-8")
    const relativeName = relative(rootDir, docPath) || basename(docPath)
    docTextByFilename.set(relativeName, text)
    docTextByFilename.set(basename(relativeName), text)
  }

  const settingsSuffix = createHash("sha256")
    .update(
      JSON.stringify({
        provider: runtimeEnv.provider,
        chatModel: runtimeEnv.chatModel,
        embeddingModel: runtimeEnv.embeddingModel,
        vectorDbHost: runtimeEnv.vectorDbHost,
        vectorDbPort: runtimeEnv.vectorDbPort,
        vectorDbDatabase: runtimeEnv.vectorDbDatabase,
        vectorDbUser: runtimeEnv.vectorDbUser,
        documents: docSignatures,
      })
    )
    .digest("hex")
    .slice(0, 12)

  const completionConfigName = withSettingsSuffix(
    runtimeEnv.completionConfigName,
    settingsSuffix
  )
  const embeddingConfigName = withSettingsSuffix(
    runtimeEnv.embeddingConfigName,
    settingsSuffix
  )
  const vectorDbName = withSettingsSuffix(
    runtimeEnv.vectorDbName,
    settingsSuffix
  )
  const knowledgeBaseName = withSettingsSuffix(
    runtimeEnv.knowledgeBaseName,
    settingsSuffix
  )
  const agentName = withSettingsSuffix(runtimeEnv.agentName, settingsSuffix)

  const api = new ApiClient(
    runtimeEnv.budibaseBaseUrl,
    runtimeEnv.appId,
    runtimeEnv.budibaseUsername,
    runtimeEnv.budibasePassword
  )
  await api.init()

  const created: CreatedResources = {}
  try {
    const configs = await api.request<any[]>("GET", "/api/configs")
    const existingCompletion = findByName(configs, completionConfigName)
    if (existingCompletion?._id) {
      created.completionConfigId = existingCompletion._id
      console.log(`Reusing completion config: ${completionConfigName}`)
    } else {
      const createdConfig = await api.request<any>("POST", "/api/configs", {
        name: completionConfigName,
        provider: runtimeEnv.provider,
        model: runtimeEnv.chatModel,
        credentialsFields: {
          api_key: runtimeEnv.openAIKey,
          api_base: runtimeEnv.openAIBaseUrl,
        },
        configType: AIConfigType.COMPLETIONS,
      })
      created.completionConfigId = createdConfig._id
      created.completionConfigCreated = true
      console.log(`Created completion config: ${completionConfigName}`)
    }

    const existingEmbedding = findByName(configs, embeddingConfigName)
    if (existingEmbedding?._id) {
      created.embeddingConfigId = existingEmbedding._id
      console.log(`Reusing embedding config: ${embeddingConfigName}`)
    } else {
      const createdConfig = await api.request<any>("POST", "/api/configs", {
        name: embeddingConfigName,
        provider: runtimeEnv.provider,
        model: runtimeEnv.embeddingModel,
        credentialsFields: {
          api_key: runtimeEnv.openAIKey,
          api_base: runtimeEnv.openAIBaseUrl,
        },
        configType: AIConfigType.EMBEDDINGS,
      })
      created.embeddingConfigId = createdConfig._id
      created.embeddingConfigCreated = true
      console.log(`Created embedding config: ${embeddingConfigName}`)
    }

    const vectorDbs = await api.request<any[]>("GET", "/api/vectordb")
    const existingVectorDb = findByName(vectorDbs, vectorDbName)
    if (existingVectorDb?._id) {
      created.vectorDbId = existingVectorDb._id
      console.log(`Reusing vector DB: ${vectorDbName}`)
    } else {
      const vectorDb = await api.request<any>("POST", "/api/vectordb", {
        name: vectorDbName,
        provider: "pgvector",
        host: runtimeEnv.vectorDbHost,
        port: runtimeEnv.vectorDbPort,
        database: runtimeEnv.vectorDbDatabase,
        user: runtimeEnv.vectorDbUser,
        password: runtimeEnv.vectorDbPassword,
      })
      created.vectorDbId = vectorDb._id
      created.vectorDbCreated = true
      console.log(`Created vector DB: ${vectorDbName}`)
    }

    const knowledgeBases = await api.request<any[]>(
      "GET",
      "/api/knowledge-base"
    )
    const existingKb = findByName(knowledgeBases, knowledgeBaseName)
    if (existingKb?._id) {
      created.knowledgeBaseId = existingKb._id
      console.log(`Reusing knowledge base: ${knowledgeBaseName}`)
    } else {
      const kb = await api.request<any>("POST", "/api/knowledge-base", {
        name: knowledgeBaseName,
        embeddingModel: created.embeddingConfigId,
        vectorDb: created.vectorDbId,
      })
      created.knowledgeBaseId = kb._id
      created.knowledgeBaseCreated = true
      console.log(`Created knowledge base: ${knowledgeBaseName}`)
    }

    const agentsResponse = await api.request<{ agents: any[] }>(
      "GET",
      "/api/agent"
    )
    const existingAgent = findByName(agentsResponse.agents || [], agentName)
    if (existingAgent?._id) {
      created.agentId = existingAgent._id
      console.log(`Reusing agent: ${agentName}`)
    } else {
      const agent = await api.request<any>("POST", "/api/agent", {
        name: agentName,
        description: "RAG eval agent",
        aiconfig: created.completionConfigId,
        knowledgeBases: [created.knowledgeBaseId],
        live: true,
      })
      created.agentId = agent._id
      created.agentCreated = true
      console.log(`Created agent: ${agentName}`)
    }

    const chatApp = await api.request<any>("GET", "/api/chatapps")
    const chatAppId = chatApp?._id
    if (!chatAppId) {
      throw new Error("Could not resolve chat app ID")
    }

    try {
      await api.request("POST", `/api/chatapps/${chatAppId}/agent`, {
        agentId: created.agentId,
      })
    } catch (error) {
      if (!shouldIgnoreAttachAgentError(error)) {
        throw error
      }
      console.log(
        `Agent ${created.agentId} already attached to chat app ${chatAppId}`
      )
    }

    const existingFilesResponse = await api.request<{ files: UploadedFile[] }>(
      "GET",
      `/api/knowledge-base/${created.knowledgeBaseId!}/files`
    )
    const existingFiles = existingFilesResponse.files || []
    const requiredFilenames: string[] = []

    for (const docPath of documentPaths) {
      const filename = relative(rootDir, docPath) || basename(docPath)
      requiredFilenames.push(filename)
      const alreadyPresent = existingFiles.some(
        file =>
          file.filename === filename &&
          (file.status === "ready" || file.status === "processing")
      )
      if (alreadyPresent) {
        console.log(`Skipping upload (already present): ${filename}`)
        continue
      }
      const fileBuffer = readFileSync(docPath)
      await api.uploadKnowledgeBaseFile(
        created.knowledgeBaseId!,
        filename,
        fileBuffer,
        getMimeType(docPath)
      )
      console.log(`Uploaded: ${filename}`)
    }

    await waitForKnowledgeBaseFilesReady(
      api,
      created.knowledgeBaseId!,
      requiredFilenames
    )

    const questions = loadQuestions(inputCsv)
    console.log(`Loaded ${questions.length} questions from ${inputCsv}`)

    const responseRows: ResponseRow[] = []
    const samples: RagasSample[] = []
    for (const [index, row] of questions.entries()) {
      const conversation = await api.request<{ _id?: string }>(
        "POST",
        `/api/chatapps/${chatAppId}/conversations`,
        {
          chatAppId,
          agentId: created.agentId,
          title: `RAG Eval ${row.rowId}`,
        }
      )
      if (!conversation._id) {
        throw new Error("Failed to create conversation")
      }

      await api.requestStream(
        `/api/chatapps/${chatAppId}/conversations/${conversation._id}/stream`,
        {
          _id: conversation._id,
          chatAppId,
          agentId: created.agentId,
          messages: [
            {
              id: `${row.rowId}-user`,
              role: "user",
              parts: [{ type: "text", text: row.question }],
            },
          ],
        }
      )

      let answer = ""
      let sourceHints: string[] = []
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const persisted = await api.request<ChatConversation>(
          "GET",
          `/api/chatapps/${chatAppId}/conversations/${conversation._id}`
        )
        answer = extractAssistantText(persisted)
        sourceHints = extractRagSourceHints(persisted)
        if (answer) {
          break
        }
        await wait(750)
      }
      const contexts = sourceHints
        .map(
          hint => docTextByFilename.get(hint) || docTextByFilename.get(basename(hint))
        )
        .filter((value): value is string => !!value)

      responseRows.push({
        row_id: row.rowId,
        question: row.question,
        reference: row.reference,
        response: answer,
        source_hints: sourceHints.join("|"),
      })
      samples.push({
        caseId: row.rowId,
        question: row.question,
        answer,
        contexts,
        reference: row.reference || undefined,
        sourceHints,
      })
      console.log(
        `[${index + 1}/${questions.length}] answer chars=${answer.length}, contexts=${contexts.length}`
      )
    }

    mkdirSync(dirname(responsesCsv), { recursive: true })
    writeFileSync(responsesCsv, toCsv(responseRows), "utf-8")
    console.log(`Saved responses to: ${responsesCsv}`)
    if (samples.length === 0) {
      throw new Error("No samples were collected for RAGAS scoring")
    }

    const ragas = runRagas(rootDir, runtimeEnv, samples, scoresJson)
    const aggregate = ragas.aggregate || {}
    const metricNames = Object.keys(aggregate).sort()
    if (metricNames.length === 0) {
      throw new Error("RAGAS returned no aggregate metrics")
    }
    for (const metricName of metricNames) {
      const value = aggregate[metricName]
      console.log(`${metricName}: ${value.toFixed(4)}`)
    }
    const overall = mean(metricNames.map(name => aggregate[name]))
    console.log(`overall_mean: ${overall.toFixed(4)}`)

    const railFailures = evaluateMetricRails(runtimeEnv, aggregate)
    let failed = false
    if (
      typeof runtimeEnv.ragasThreshold === "number" &&
      overall < runtimeEnv.ragasThreshold
    ) {
      failed = true
      console.log(
        `RAGAS overall mean ${overall.toFixed(4)} is below threshold ${runtimeEnv.ragasThreshold.toFixed(4)}`
      )
    }
    for (const failure of railFailures) {
      failed = true
      console.log(`RAGAS rail failed: ${failure}`)
    }
    console.log(`Saved RAGAS output to: ${scoresJson}`)
    if (failed) {
      process.exitCode = 1
    }
  } finally {
    if (!runtimeEnv.keepResources) {
      await cleanupResources(api, created)
    } else {
      console.log("Keeping resources because RAG_EVAL_KEEP_RESOURCES=1 is set")
      console.log(`Agent ID: ${created.agentId || "<none>"}`)
      console.log(`Knowledge Base ID: ${created.knowledgeBaseId || "<none>"}`)
      console.log(`Vector DB ID: ${created.vectorDbId || "<none>"}`)
    }
    api.clearSession()
  }
}

main().catch(error => {
  const message =
    typeof error === "string"
      ? error
      : (error as any)?.message || String(error || "Unknown error")
  console.error(message)
  process.exit(1)
})
