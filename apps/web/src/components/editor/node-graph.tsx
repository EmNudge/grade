import { type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  type NodeMouseHandler,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { EyeOff, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEditor } from '../../editor/store'
import { GradeNodeView } from './grade-node'

const SWATCHES = [
  '#f59e0b',
  '#ef4444',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#eab308',
]

interface Menu {
  x: number
  y: number
  id?: string // present -> node menu; absent -> pane menu
}

export function NodeGraph() {
  const nodes = useEditor((s) => s.nodes)
  const edges = useEditor((s) => s.edges)
  const onNodesChange = useEditor((s) => s.onNodesChange)
  const onEdgesChange = useEditor((s) => s.onEdgesChange)
  const onConnect = useEditor((s) => s.onConnect)
  const resetNode = useEditor((s) => s.resetNode)
  const deleteNode = useEditor((s) => s.deleteNode)
  const selectNode = useEditor((s) => s.selectNode)
  const toggleNodeEnabled = useEditor((s) => s.toggleNodeEnabled)
  const setNodeLabel = useEditor((s) => s.setNodeLabel)
  const setNodeAccent = useEditor((s) => s.setNodeAccent)
  const addCorrectorAt = useEditor((s) => s.addCorrectorAt)
  const { screenToFlowPosition } = useReactFlow()

  const nodeTypes = useMemo(() => ({ grade: GradeNodeView }), [])
  const [menu, setMenu] = useState<Menu | null>(null)
  const menuNode = menu?.id ? nodes.find((n) => n.id === menu.id) : null

  const onNodeContextMenu: NodeMouseHandler = (e, node) => {
    e.preventDefault()
    if (node.data['role'] !== 'effect') return // I/O nodes aren't editable
    selectNode(node.id)
    setMenu({ x: e.clientX, y: e.clientY, id: node.id })
  }

  const onPaneContextMenu = (e: MouseEvent | ReactMouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div className="relative size-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        fitView
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ animated: true }}
        colorMode="dark"
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} />
          <div
            className="fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            {menuNode ? (
              <>
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  value={menuNode.data.label ?? 'Corrector'}
                  onChange={(e) => setNodeLabel(menuNode.id, e.target.value)}
                  placeholder="Label"
                  className="mb-1 w-full rounded bg-input/40 px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <div className="mb-1 flex flex-wrap gap-1 px-1 py-1">
                  {SWATCHES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNodeAccent(menuNode.id, c)}
                      className="size-4 rounded-full ring-1 ring-inset ring-black/30 transition-transform hover:scale-110"
                      style={{ background: c }}
                      title={c}
                      aria-label={`Set node colour ${c}`}
                    />
                  ))}
                </div>
                <MenuItem
                  icon={<EyeOff className="size-3.5" />}
                  shortcut="⌘D"
                  onClick={() => {
                    toggleNodeEnabled(menuNode.id)
                    setMenu(null)
                  }}
                >
                  {menuNode.data.enabled === false ? 'Enable' : 'Disable'} node
                </MenuItem>
                <MenuItem
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={() => {
                    resetNode(menuNode.id)
                    setMenu(null)
                  }}
                >
                  Reset node
                </MenuItem>
                <MenuItem
                  icon={<Trash2 className="size-3.5" />}
                  destructive
                  onClick={() => {
                    deleteNode(menuNode.id)
                    setMenu(null)
                  }}
                >
                  Delete node
                </MenuItem>
              </>
            ) : (
              <MenuItem
                icon={<Plus className="size-3.5" />}
                onClick={() => {
                  addCorrectorAt(screenToFlowPosition({ x: menu.x, y: menu.y }))
                  setMenu(null)
                }}
              >
                Add corrector
              </MenuItem>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  children,
  shortcut,
  destructive,
  onClick,
}: {
  icon: ReactNode
  children: ReactNode
  shortcut?: string
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted ${
        destructive ? 'text-destructive' : ''
      }`}
    >
      {icon}
      {children}
      {shortcut && <span className="ml-auto text-[10px] text-muted-foreground">{shortcut}</span>}
    </button>
  )
}
