import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import {
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  Text,
  VStack,
} from '@astryxdesign/core';
import {
  DEFAULT_AVATAR_CROP,
  clamp,
  normalizeAvatarCrop,
  type AvatarCrop,
} from './prepareAvatar';
import './AvatarCrop.css';

const VIEW = 280;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originPanX: number;
  originPanY: number;
};

function panTravel(naturalW: number, naturalH: number, zoom: number): { x: number; y: number } {
  const minSide = Math.min(naturalW, naturalH);
  const scale = (VIEW / minSide) * zoom;
  return {
    x: Math.max(0, naturalW * scale - VIEW),
    y: Math.max(0, naturalH * scale - VIEW),
  };
}

/**
 * Circular preview with drag-to-pan and zoom so the user can frame a photo
 * before it is square-cropped for upload.
 */
export function AvatarCropDialog({
  open,
  imageUrl,
  naturalWidth,
  naturalHeight,
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  imageUrl: string | null;
  naturalWidth: number;
  naturalHeight: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (crop: AvatarCrop) => void;
}) {
  const [crop, setCrop] = useState<AvatarCrop>(DEFAULT_AVATAR_CROP);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (open) setCrop(DEFAULT_AVATAR_CROP);
  }, [open, imageUrl]);

  const framed = normalizeAvatarCrop(crop);
  const travel = panTravel(naturalWidth, naturalHeight, framed.zoom);
  const minSide = Math.min(naturalWidth, naturalHeight) || 1;
  const scale = (VIEW / minSide) * framed.zoom;
  const displayW = naturalWidth * scale;
  const displayH = naturalHeight * scale;
  const tx = travel.x === 0 ? 0 : -(travel.x / 2) * (1 + framed.panX);
  const ty = travel.y === 0 ? 0 : -(travel.y / 2) * (1 + framed.panY);

  function setZoom(next: number) {
    const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
    setCrop((prev) => normalizeAvatarCrop({ ...prev, zoom }));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (busy || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originPanX: framed.panX,
      originPanY: framed.panY,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const panX = travel.x > 0 ? drag.originPanX - (2 * dx) / travel.x : 0;
    const panY = travel.y > 0 ? drag.originPanY - (2 * dy) / travel.y : 0;
    setCrop(normalizeAvatarCrop({ zoom: framed.zoom, panX, panY }));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    if (busy) return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.12 : 0.12;
    setZoom(framed.zoom + delta);
  }

  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => { if (!next && !busy) onCancel(); }}
      purpose="form"
      width={400}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="Frame your photo"
            subtitle="Drag to pan, scroll or use the slider to zoom — fill the circle."
            onOpenChange={() => { if (!busy) onCancel(); }}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4} className="avatar-crop">
              <div
                className="avatar-crop-stage"
                role="img"
                aria-label="Profile photo crop preview. Drag to pan."
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onWheel={onWheel}
              >
                {imageUrl ? (
                  <img
                    className="avatar-crop-image"
                    src={imageUrl}
                    alt=""
                    draggable={false}
                    style={{
                      width: `${displayW}px`,
                      height: `${displayH}px`,
                      transform: `translate(${tx}px, ${ty}px)`,
                    }}
                  />
                ) : null}
                <div className="avatar-crop-mask" aria-hidden="true" />
              </div>
              <VStack gap={2} className="avatar-crop-zoom">
                <Text type="supporting">Zoom</Text>
                <input
                  className="avatar-crop-slider"
                  type="range"
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={0.01}
                  value={framed.zoom}
                  disabled={busy}
                  aria-label="Zoom"
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                variant="ghost"
                label="Cancel"
                isDisabled={busy}
                onClick={onCancel}
              />
              <Button
                variant="primary"
                label={busy ? 'Uploading…' : 'Use photo'}
                isDisabled={busy || !imageUrl}
                onClick={() => onConfirm(framed)}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
