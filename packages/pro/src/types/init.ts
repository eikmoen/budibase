import { Database, WorkspaceBackupContents } from "@budibase/types"

export interface InitOpts {
  backups?: BackupInitOpts
}

// BACKUPS

export interface BackupInitOpts {
  processing: BackupProcessingOpts
}

export interface ImportWorkspaceConfig {
  file: {
    type: string
    path: string
  }
  key: string
}

export interface ImportWorkspaceOpts {
  updateAttachmentColumns?: boolean
  importObjStoreContents?: boolean
  objectStoreWorkspaceId?: string
}

type ExportWorkspaceFn = (
  devWorkspaceId: string,
  opts: { tar: boolean }
) => Promise<string>
type ImportWorkspaceFn = (
  targetWorkspaceId: string,
  destinationDb: Database,
  config: ImportWorkspaceConfig,
  opts?: ImportWorkspaceOpts
) => Promise<string>
type StatsFn = (devWorkspaceId: string) => Promise<WorkspaceBackupContents>

export interface BackupProcessingOpts {
  exportWorkspaceFn: ExportWorkspaceFn
  importWorkspaceFn: ImportWorkspaceFn
  statsFn: StatsFn
}
