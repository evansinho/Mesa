import { Outlet } from '@tanstack/react-router'
import { SideNav } from './SideNav'
import { TabBar } from './TabBar'
import { OrderDetail } from './OrderDetail'
import { useOverlay } from '../context/OverlayContext'

export default function AppLayout() {
  const { overlay, closeOverlay } = useOverlay()

  return (
    <div className="app">
      <SideNav />
      <div className="screen-wrap">
        <div className="screen">
          <div className="screen-scroll pb-tab">
            <Outlet />
          </div>
        </div>
      </div>
      <TabBar />
      {overlay?.type === 'order-detail' && (
        <OrderDetail orderId={overlay.orderId} onBack={closeOverlay} />
      )}
    </div>
  )
}
