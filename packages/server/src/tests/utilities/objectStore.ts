import { db, objectStore } from "@budibase/backend-core"

export async function getWorkspaceObjectStorageEtags(workspaceId: string) {
  workspaceId = db.getProdWorkspaceID(workspaceId)

  const objects = await objectStore.getAllFiles(
    objectStore.ObjectStoreBuckets.WORKSPACES,
    workspaceId
  )

  const fileEtags = Object.entries(objects).reduce<Record<string, string>>(
    (etags, [key, object]) => {
      if (object.ETag) {
        etags[key.replace(new RegExp(`^${workspaceId}/`), "")] =
          object.ETag.replace(new RegExp('^"'), "").replace(
            new RegExp('"$'),
            ""
          )
      }
      return etags
    },
    {}
  )
  return fileEtags
}
