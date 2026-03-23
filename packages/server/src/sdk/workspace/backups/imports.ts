import { db as dbCore, encryption, objectStore } from "@budibase/backend-core"
import { utils } from "@budibase/shared-core"
import {
  Automation,
  AutomationTriggerStepId,
  Database,
  FieldType,
  Row,
  RowAttachment,
  WebhookTriggerInputs,
} from "@budibase/types"
import fs from "fs"
import fsp from "fs/promises"
import { join } from "path"
import * as tar from "tar"
import { v4 as uuid } from "uuid"
import sdk from "../.."
import { ObjectStoreBuckets } from "../../../constants"
import { getAutomationParams } from "../../../db/utils"
import { budibaseTempDir } from "../../../utilities/budibaseDir"
import { downloadTemplate } from "../../../utilities/fileSystem"
import {
  ATTACHMENT_DIRECTORY,
  DB_EXPORT_FILE,
  GLOBAL_DB_EXPORT_FILE,
} from "./constants"

type TemplateType = {
  file?: {
    type?: string
    path: string
    password?: string
  }
  key?: string
}

function rewriteAttachmentUrl(workspaceId: string, attachment: RowAttachment) {
  // URL looks like: /prod-budi-app-assets/workspaceId/attachments/file.csv
  const urlParts = attachment.key?.split("/") || []
  // remove the workspace ID
  urlParts.shift()
  // add new workspace ID
  urlParts.unshift(workspaceId)
  const key = urlParts.join("/")
  return {
    ...attachment,
    key,
    url: "", // calculated on retrieval using key
  }
}

export async function updateAttachmentColumns(
  prodWorkspaceId: string,
  db: Database
) {
  // iterate through attachment documents and update them
  const tables = await sdk.tables.getAllInternalTables(db)
  let updatedRows: Row[] = []
  for (let table of tables) {
    const { rows, columns } = await sdk.rows.getRowsWithAttachments(
      db.name,
      table
    )
    updatedRows = updatedRows.concat(
      rows.map(row => {
        for (let column of columns) {
          const columnType = table.schema[column].type
          if (
            columnType === FieldType.ATTACHMENTS &&
            Array.isArray(row[column])
          ) {
            row[column] = row[column].map((attachment: RowAttachment) =>
              rewriteAttachmentUrl(prodWorkspaceId, attachment)
            )
          } else if (
            (columnType === FieldType.ATTACHMENT_SINGLE ||
              columnType === FieldType.SIGNATURE_SINGLE) &&
            row[column]
          ) {
            row[column] = rewriteAttachmentUrl(prodWorkspaceId, row[column])
          }
        }
        return row
      })
    )
  }
  // write back the updated attachments
  await db.bulkDocs(updatedRows)
}

async function updateAutomations(prodWorkspaceId: string, db: Database) {
  const automations = (
    await db.allDocs(
      getAutomationParams(null, {
        include_docs: true,
      })
    )
  ).rows.map(row => row.doc) as Automation[]
  const devId = dbCore.getDevWorkspaceID(prodWorkspaceId)
  let toSave: Automation[] = []
  for (let automation of automations) {
    const oldDevWorkspaceId = automation.appId,
      oldProdWorkspaceId = dbCore.getProdWorkspaceID(automation.appId)
    if (
      automation.definition.trigger?.stepId === AutomationTriggerStepId.WEBHOOK
    ) {
      const old = automation.definition.trigger.inputs as WebhookTriggerInputs
      automation.definition.trigger.inputs = {
        schemaUrl: old.schemaUrl.replace(oldDevWorkspaceId, devId),
        triggerUrl: old.triggerUrl.replace(oldProdWorkspaceId, prodWorkspaceId),
      }
    }
    automation.appId = devId
    toSave.push(automation)
  }
  await db.bulkDocs(toSave)
}

/**
 * This function manages temporary template files which are stored by Koa.
 * @param template The template object retrieved from the Koa context object.
 * @returns Returns a fs read stream which can be loaded into the database.
 */
async function getTemplateStream(template: TemplateType) {
  if (template.file && template.file.type !== "text/plain") {
    throw new Error("Cannot import a non-text based file.")
  }
  if (template.file) {
    return fs.createReadStream(template.file.path)
  } else if (template.key) {
    const [type, name] = template.key.split("/")
    const tmpPath = await downloadTemplate(type, name)
    return fs.createReadStream(join(tmpPath, name, "db", "dump.txt"))
  } else {
    throw new Error("Either file or key is required.")
  }
}

export async function untarFile(file: { path: string }) {
  const tmpPath = join(budibaseTempDir(), uuid())
  await fsp.mkdir(tmpPath)
  // extract the tarball
  await tar.extract({
    cwd: tmpPath,
    file: file.path,
  })
  return tmpPath
}

async function decryptFiles(path: string, password: string) {
  try {
    const processDirectory = async (dirPath: string) => {
      for (let file of await fsp.readdir(dirPath)) {
        const inputPath = join(dirPath, file)
        if (!inputPath.endsWith(ATTACHMENT_DIRECTORY)) {
          const stats = await fsp.lstat(inputPath)
          if (stats.isFile() && inputPath.endsWith(".enc")) {
            const outputPath = inputPath.replace(/\.enc$/, "")
            await encryption.decryptFile(inputPath, outputPath, password)
            await fsp.rm(inputPath)
          } else if (stats.isDirectory()) {
            await processDirectory(inputPath)
          }
        }
      }
    }

    await processDirectory(path)
  } catch (err: any) {
    if (err.message === "incorrect header check") {
      throw new Error("File cannot be imported")
    }
    throw err
  }
}

export function getGlobalDBFile(tmpPath: string) {
  return fs.readFileSync(join(tmpPath, GLOBAL_DB_EXPORT_FILE), "utf8")
}

export function getListOfAppsInMulti(tmpPath: string) {
  return fs.readdirSync(tmpPath).filter(dir => dir !== GLOBAL_DB_EXPORT_FILE)
}

export interface ImportWorkspaceOpts {
  updateAttachmentColumns?: boolean
  importObjStoreContents?: boolean
  objectStoreWorkspaceId?: string
}

export async function importWorkspace(
  workspaceId: string,
  db: Database,
  template: TemplateType,
  opts: ImportWorkspaceOpts = {}
) {
  const importOpts: ImportWorkspaceOpts = {
    updateAttachmentColumns: true,
    importObjStoreContents: true,
    ...opts,
  }
  const prodWorkspaceId = dbCore.getProdWorkspaceID(workspaceId)
  const objectStoreWorkspaceId =
    importOpts.objectStoreWorkspaceId ?? workspaceId
  const objectStoreProdWorkspaceId = dbCore.getProdWorkspaceID(
    objectStoreWorkspaceId
  )
  let dbStream: fs.ReadStream
  const isTar = template.file && template?.file?.type?.endsWith("gzip")
  const isDirectory =
    template.file && (await fsp.lstat(template.file.path)).isDirectory()
  let tmpPath: string | undefined = undefined
  if (template.file && (isTar || isDirectory)) {
    tmpPath = isTar ? await untarFile(template.file) : template.file.path
    if (isTar && template.file.password) {
      await decryptFiles(tmpPath, template.file.password)
    }
    const contents = await fsp.readdir(tmpPath)
    const stillEncrypted = !!contents.find(name => name.endsWith(".enc"))
    if (stillEncrypted) {
      throw new Error("Files are encrypted but no password has been supplied.")
    }
    const isPlugin = !!contents.find(name => name === "plugin.min.js")
    if (isPlugin) {
      throw new Error("Supplied file is a plugin - cannot import as workspace.")
    }
    const isInvalid = !contents.find(name => name === DB_EXPORT_FILE)
    if (isInvalid) {
      throw new Error(
        "Workspace export does not appear to be valid - no DB file found."
      )
    }
    // have to handle object import
    if (importOpts.importObjStoreContents) {
      const promises = []
      const excludedFiles = [GLOBAL_DB_EXPORT_FILE, DB_EXPORT_FILE]

      for (let filename of contents) {
        const path = join(tmpPath, filename)
        if (excludedFiles.includes(filename)) {
          continue
        }
        filename = join(objectStoreProdWorkspaceId, filename)
        if ((await fsp.lstat(path)).isDirectory()) {
          promises.push(
            objectStore.uploadDirectory(
              ObjectStoreBuckets.WORKSPACES,
              path,
              filename
            )
          )
        } else {
          promises.push(
            objectStore.upload({
              bucket: ObjectStoreBuckets.WORKSPACES,
              path,
              filename,
            })
          )
        }
      }
      await Promise.all(promises)
      const uploadedFiles = await fsp.readdir(tmpPath, { recursive: true })

      const filesToDelete: string[] = []
      await utils.parallelForeach(
        objectStore.listAllObjects(
          objectStore.ObjectStoreBuckets.WORKSPACES,
          objectStoreProdWorkspaceId
        ),
        async file => {
          if (
            file.Key &&
            !uploadedFiles.includes(
              file.Key.replace(
                new RegExp(`^${objectStoreProdWorkspaceId}/`),
                ""
              )
            )
          ) {
            filesToDelete.push(file.Key)
          }
        },
        5
      )

      if (filesToDelete.length) {
        await objectStore.deleteFiles(
          objectStore.ObjectStoreBuckets.WORKSPACES,
          filesToDelete
        )
      }
    }
    dbStream = fs.createReadStream(join(tmpPath, DB_EXPORT_FILE))
  } else {
    dbStream = await getTemplateStream(template)
  }
  const { ok } = await db.load(dbStream)
  if (!ok) {
    throw "Error loading database dump from template."
  }
  if (importOpts.updateAttachmentColumns) {
    await updateAttachmentColumns(prodWorkspaceId, db)
  }
  await updateAutomations(prodWorkspaceId, db)
  // clear up afterward
  if (tmpPath) {
    await fsp.rm(tmpPath, { recursive: true, force: true })
  }
  return ok
}
