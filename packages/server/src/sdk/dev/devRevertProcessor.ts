import {
  cache,
  context,
  db as dbCore,
  events,
  queue,
} from "@budibase/backend-core"
import {
  DeploymentDoc,
  DevRevertQueueData,
  DocumentType,
  Workspace,
} from "@budibase/types"
import { isWorkspacePublished } from "../workspace/workspaces/utils"
let _devRevertProcessor: DevRevertProcessor | undefined

class DevRevertProcessor extends queue.QueuedProcessor<DevRevertQueueData> {
  constructor() {
    super(queue.JobQueue.DEV_REVERT_PROCESSOR, {
      maxAttempts: 3,
      removeOnFail: false,
      removeOnComplete: false,
      maxStalledCount: 3,
      waitForCompletionMs: 10000,
    })
  }

  protected processFn = async (
    data: DevRevertQueueData
  ): Promise<{ message: string }> => {
    return await context.doInWorkspaceContext(data.workspaceId, () =>
      this.revertWorkspace(data)
    )
  }

  private async revertWorkspace(
    data: DevRevertQueueData
  ): Promise<{ message: string }> {
    const { workspaceId } = data
    const productionWorkspaceId = dbCore.getProdWorkspaceID(workspaceId)

    // Workspace must have been deployed first
    const db = context.getProdWorkspaceDB({ skip_setup: true })

    const isPublished = await isWorkspacePublished(productionWorkspaceId)
    if (!isPublished) {
      throw new queue.UnretriableError(
        "Workspace must be deployed to be reverted."
      )
    }
    const deploymentDoc = await db.get<DeploymentDoc>(DocumentType.DEPLOYMENTS)
    if (
      !deploymentDoc.history ||
      Object.keys(deploymentDoc.history).length === 0
    ) {
      throw new queue.UnretriableError("No deployments for workspace")
    }

    const replication = new dbCore.Replication({
      source: productionWorkspaceId,
      target: workspaceId,
    })

    try {
      await replication.rollback()

      // update workspaceID in reverted workspace to be dev version again
      const db = context.getWorkspaceDB()
      const workspaceDoc = await db.get<Workspace>(
        DocumentType.WORKSPACE_METADATA
      )
      workspaceDoc.appId = workspaceId
      workspaceDoc.instance._id = workspaceId
      await db.put(workspaceDoc)
      await cache.workspace.invalidateWorkspaceMetadata(workspaceId)
      await events.workspace.reverted(workspaceDoc)

      return { message: "Reverted changes successfully." }
    } catch (err) {
      throw new Error(`Unable to revert. ${err}`, { cause: err })
    } finally {
      await replication.close()
    }
  }
}

export function devRevertProcessor(): DevRevertProcessor {
  if (!_devRevertProcessor) {
    _devRevertProcessor = new DevRevertProcessor()
  }
  return _devRevertProcessor
}

export async function revertDevChanges(data: DevRevertQueueData) {
  const processor = devRevertProcessor()
  const result = await processor.execute(data)
  return result
}
