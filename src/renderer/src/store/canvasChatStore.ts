import { create } from 'zustand'

export type CanvasChatMessageStatus = 'sending' | 'sent' | 'failed'

export interface CanvasChatMessage {
  id: string
  profileId: string
  workspaceSessionId?: string
  text: string
  createdAt: number
  status: CanvasChatMessageStatus
}

interface CanvasChatState {
  messages: CanvasChatMessage[]
  append(message: CanvasChatMessage): void
  setStatus(id: string, status: CanvasChatMessageStatus): void
  clear(): void
}

export const useCanvasChatStore = create<CanvasChatState>((set) => ({
  messages: [],
  append: (message) => set((state) => ({ messages: [...state.messages, message] })),
  setStatus: (id, status) => set((state) => ({
    messages: state.messages.map((message) => message.id === id ? { ...message, status } : message)
  })),
  clear: () => set({ messages: [] })
}))

export function messagesForThread(
  messages: CanvasChatMessage[],
  profileId: string,
  workspaceSessionId?: string
): CanvasChatMessage[] {
  return messages.filter((message) =>
    message.profileId === profileId && message.workspaceSessionId === workspaceSessionId
  )
}
