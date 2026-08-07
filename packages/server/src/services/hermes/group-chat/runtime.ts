import type { GroupChatServer } from './index'

let runtimeServer: GroupChatServer | null = null

export function setGroupChatRuntimeServer(server: GroupChatServer | null): void {
    runtimeServer = server
}

export function getGroupChatRuntimeServer(): GroupChatServer | null {
    return runtimeServer
}
