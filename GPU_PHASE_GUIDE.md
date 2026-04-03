# GPU Phase — What We Built and What the Output Should Look Like

This document covers every GPU feature added after the initial CPU MPR, explains the underlying idea in plain terms, and describes exactly what a correct output looks like so you can compare against what you are actually seeing.

---

## 1. GPU Volume Upload (`gpu-volume.js`)

### What it does

Before any GPU rendering can happen, the entire CT/MR volume must live on the graphics card as a 3D texture. This is what `gpu-volume.js` does — nothing else.

1. Takes the `Float32Array` volume (already built by the MPR volume builder, with HU scaling applied).
2. Finds the minimum and maximum HU value across the whole volume.
3. Normalises every voxel to the range `[0, 1]`: `norm = (hu - min) / (max - min)`.
4. Uploads the result to GPU memory as a WebGL2 `TEXTURE_3D` in `R16F` (half-float, 16-bit) format.
5. Returns a `gpuHandle` object containing the GL context, the texture reference, and the `min`/`max` values for later use.

### Why R16F and not R8

`R8` (8-bit unsigned) can only hold 256 distinct levels. A typical CT scan spans roughly 4000 HU (from −1000 air to +3000 bone). With `R8`, each level represents 4000 / 256 ≈ **16 HU steps**. When you apply a window of 400 HU (standard soft tissue), only 400 / 16 = **25 visible grey levels** remain — the image looks posterised and washed out.

`R16F` (16-bit half-float) has an effective precision of ~1024 levels across the normalised range, which gives 1024 / (400 / 4000) = **~100 visible grey levels** for the same soft-tissue window. The image looks smooth and diagnostic.

### Expected output at this stage

`gpu-volume.js` produces no visible output on its own. What you should see is:

- No JavaScript errors in the browser console.
- `gpuVolume.isWebGLAvailable()` returns `true` on a modern GPU machine.
- The GPU / DRR / 3D buttons become visible in the UI when a CT or MR series with more than one slice is loaded.
- On a machine without WebGL2 (old GPU, software renderer), `uploadVolumeToGPU()` returns `null` and those buttons stay hidden.

### Signs something is wrong

| Symptom | Likely cause |
|---------|-------------|
| GPU buttons never appear | `isWebGLAvailable()` returning false, or modality is not CT/MR, or series has only 1 slice |
| Console error "Failed to load: gpu-volume.js" | Script tag order wrong in HTML; gpu-volume.js must load before any renderer that depends on it |
| Console error about TEXTURE_3D | Browser does not support WebGL2 |

---

## 2. GPU MPR Slicer (`gpu-slice.js`)

### What it does

Instead of running JavaScript loops to copy voxels into a `Float32Array` then painting a 2D canvas, the GPU MPR slicer sends the whole job to the graphics card. A single GLSL fragment shader handles all three planes (axial, coronal, sagittal) by changing three uniforms that define the slice orientation:

```
coord = u_origin + v_uv.x * u_dx + v_uv.y * u_dy
```

where `v_uv` is the texture coordinate of the current pixel (0…1 across the canvas), and `u_origin`, `u_dx`, `u_dy` together define a flat cross-section through the 3D texture.

W/L (window/level) is also applied inside the shader:
```
hu  = norm × (max − min) + min          // undo normalisation
val = clamp((hu − (wc − ww/2)) / ww, 0, 1)   // W/L ramp
```

### Expected output — GPU MPR

When GPU mode is working correctly each of the three panels should look **identical to the CPU MPR** for the same slice and the same W/L settings. Specifically:

**Axial panel**
- Shows a horizontal cross-section of the patient (looking from head to feet).
- Left side of the image = patient's right side (radiological convention — `R` on the left edge).
- Bone appears bright white at standard bone window; soft tissue is mid-grey at soft-tissue window.
- Should not be flipped left-right compared to the CPU view.

**Coronal panel**
- Shows the patient from the front.
- Left side of the image = patient's right (`L` label on the right edge, `R` on the left).
- Top of the image = head (superior), bottom = feet (inferior) — labels `S` top, `I` bottom.
- Bright dots/bands across the width represent bones (ribs visible, spine in the centre).

**Sagittal panel**
- Shows the patient from the side.
- Left side of the image = anterior (front of the patient), right = posterior (back).
- Top = superior (head), bottom = inferior (feet).
- Spine appears as a bright vertical column toward the right of the image.

**Both modes showing simultaneously (transitional state)**

During development the CPU canvases and GPU canvases were both visible. In the final version:
- GPU mode hides the three original CPU canvases and creates its own labelled green-outlined canvases.
- CPU mode shows the original canvases.
- You should never see both sets of three panels at once.

### Common issues and what they look like

| Symptom | Likely cause |
|---------|-------------|
| Image appears correctly shaped but completely black | W/L uniforms not being set — shader receives `ww = 0` so every pixel clamps to 0 |
| Image is a uniform grey (not black) | Normalisation pass broken — `min == max`, all voxels map to 0 or 0.5 |
| Image looks washed out / low contrast | R8 texture in use instead of R16F; or WW is far too wide |
| Axial looks right but coronal/sagittal are black | `u_origin`, `u_dx`, `u_dy` uniforms not updated for those planes |
| Image is flipped left-right versus CPU | The `u_dy` Y direction is wrong — texture Y-flip not applied. In GPU: axial uses `dy=(0,−1,0)` to flip the image so row 0 appears at the top of the screen |
| Coronal image looks squashed vertically | Aspect ratio correction not applied to the canvas size |

---

## 3. 3D Volume Renderer — MIP mode (`volume-render.js`)

### What it does

The 3D volume tab opens a new browser window and renders a perspective ray-cast through the entire volume. In **MIP (Maximum Intensity Projection)** mode:

1. For each pixel on screen, one ray is cast from the camera position through the volume.
2. The ray is clipped to the unit cube (volume bounding box) using a slab intersection test.
3. 256 equally-spaced samples are taken along the ray.
4. At each sample, the normalised texture value is converted back to HU, then windowed using the current WC/WW.
5. The **maximum** windowed value along the entire ray is kept.
6. That maximum is output as a greyscale intensity.

The camera orbits the volume centre at a fixed radius. Dragging the mouse changes `theta` (azimuth) and `phi` (elevation), rotating the view.

### Expected output — MIP

**What a correct MIP should look like on a chest CT:**

- The image looks like a chest X-ray but with everything visible simultaneously — no overlapping soft tissue hiding the bones, because the maximum along each ray is kept.
- Ribs appear as bright white arcs.
- The spine appears as a bright white column in the centre.
- Lung tissue (which is mostly air, low HU) is very dark or black in the background.
- With the **Bone** W/L preset (WC 400, WW 1800): skeleton is fully visible; soft tissue is barely visible (its HU is below the windowed range).
- With the **Lung** W/L preset (WC −600, WW 1600): lung parenchyma and airways are visible; bone clips to white.
- Dragging the mouse rotates the projected skeleton in 3D — it should spin smoothly at roughly 60 fps.
- The status line at the bottom should update: `θ 45.0°  φ 60.0°  |  WC 400  WW 1800`.

**What the image should NOT look like:**

- It should not look like the CPU MPR axial slice — the 3D tab renders an aggregate projection, not a single flat slice.
- It should not be all-white — that means WC/WW is set so that every HU value is inside the window.
- It should not be all-black — that means WC/WW is set so that no voxel falls inside the window.
- It should not be static when you drag — if the canvas is not responding, check that `requestRender()` is being called on `mousemove`.

### Expected output — Transfer Function (TF) mode

Switching to a TF preset changes from MIP to front-to-back alpha compositing. The look is fundamentally different from MIP: instead of a flat projection, structures have a pseudo-3D shaded appearance because opacity builds up as the ray passes through dense material.

**Bone preset**
- Cortical bone (ribs, spine, pelvis) appears as a bright **ivory/cream** solid surface.
- The inner cancellous bone is slightly translucent — you can see the interior.
- Soft tissue contributes a very faint pink haze behind the bone.
- The overall image should look like an anatomy model — a skeleton with translucent flesh.
- Background is black.

**Soft Tissue preset**
- Bone becomes a faint grey ghost — barely visible.
- The dominant structures are the organs: liver, kidneys, and muscles appear **pink/red**.
- Fat surrounding the organs and under the skin appears **yellow-orange**.
- Background is black.
- On a chest CT: the heart and great vessels should be the brightest structure; lungs should be dark because they are mostly air.

**Lung preset**
- Lung parenchyma appears **cyan/blue** — the air-filled tissue is the dominant structure.
- Blood vessels running through the lung appear **red** (higher HU than parenchyma).
- Ribs appear as **ivory** arcs around the edges.
- Background is black.
- On a chest CT this should look distinctly different from MIP — the lung fields fill the image with colour.

**Known limitation of the current TF presets**

The transfer functions are authored against the assumed CT HU range of `[−1000, +3000]`. If the actual volume has a different range (e.g., an MR scan, or a CT with extreme outlier voxels), the TF x-coordinates will not align with the anatomical HU values. The result is typically an all-black or near-black image, or incorrect colours. This is a known issue and has not yet been fixed.

---

## 4. DRR Renderer (`drr-render.js`)

### What it does

The DRR (Digitally Reconstructed Radiograph) tab simulates a plain X-ray from the CT volume. Unlike MIP which keeps the maximum value, DRR **sums** the attenuation along each ray and then applies exponential inversion:

```
attenuation_sum = Σ max(0, HU + 1000) × stepSize    (over 256 steps)
transmitted     = exp(−attenuation_sum × scale)
pixel_value     = transmitted                         (1 = white, 0 = black)
```

The rays are **orthographic** (parallel), meaning every pixel's ray travels in exactly the same direction. This is different from perspective rendering — there is no vanishing point and no fish-eye distortion. Orthographic projection is the correct model for diagnostic radiographs.

### Expected output — DRR

**AP view (Anterior-Posterior, default)**

This is the equivalent of a standard chest or abdominal PA X-ray:

- Background (outside the patient) is **white** (exp(0) = 1, no attenuation through air).
- Lung fields are **light grey** — lung is mostly air but contains some soft tissue and blood.
- Soft tissue of the chest wall / abdomen is **medium grey**.
- Ribs appear as **darker grey** curved arcs across the chest — more HU = more attenuation = darker.
- The spine appears as a **dark vertical stripe** down the centre — dense bone = high attenuation.
- The diaphragm domes are visible as curved darker bands at the base of the chest.
- The overall appearance should closely resemble a real chest X-ray seen on a lightbox — dark bone on a light background.

**Lateral view**

- The spine becomes a broad dark vertical band at the posterior (right side of image for a left lateral).
- The ribs are seen end-on and appear as short dark ovals or streaks.
- The sternum is visible as a dark structure at the anterior (left side of image).

**Superior view (beam travelling inferior-to-superior)**

- This is a "top-down" projection — equivalent to a CT scout in the axial plane.
- The spine is seen as a dark oval in the centre.
- The rib cage appears as an oval ring of dark material.
- Lung fields fill the interior as lighter areas.

**What changes with the contrast slider**

The contrast slider controls the `u_scale` uniform (range 0.001–0.020):

- **Low scale (slider at 1–3):** The image appears washed out — everything is light grey, bone barely distinguishable from soft tissue. This happens when `exp(−sum × scale)` stays close to 1.0 even for bone.
- **Good scale (slider at 3–7 for most CT):** Bone appears clearly dark, soft tissue is mid-grey, lung is near-white. This is the target.
- **High scale (slider at 15–20):** The image becomes very dark — nearly everything saturates to black. Only air paths remain white.

The correct slider value depends on the actual CT dose and field of view. Start at 3 and increase until bone becomes clearly darker than soft tissue.

### Expected output — drag rotation

Dragging the mouse should rotate the projection direction continuously and smoothly:

- Horizontal drag → azimuth rotation (the patient appears to rotate left/right — same as rotating an X-ray tube around the patient).
- Vertical drag → elevation rotation (the beam tilts from horizontal toward top-down or bottom-up).
- The structure of the patient should remain centred throughout rotation.
- At extreme elevation (near the poles), the image may distort slightly — this is expected because the basis vector calculation becomes degenerate near phi = 0 or phi = π; the code clamps phi to [0.05, π−0.05] to minimise this.

---

## 5. Tab Communication (postMessage)

All GPU tabs (MPR, 3D, DRR) use the same handshake pattern:

```
Main window         →  opens new tab
New tab             →  signals {type: 'mpr-ready' / 'vol-ready' / 'drr-ready'}
Main window         →  sends {type: 'mpr-data' / 'vol-data' / 'drr-data', imageIds, series, ...}
New tab             →  decodes DICOM, builds volume, renders
```

### Expected behaviour

- The new tab opens and shows a loading overlay with a progress bar.
- The progress bar animates from 0% to 100% as slices are decoded (this takes a few seconds for a large series — 125 slices of 512×512 typically takes 3–8 seconds depending on hardware).
- Once decoding is done, "Uploading to GPU…" appears briefly.
- The overlay disappears and the rendered image appears.

### Signs the handshake is broken

| Symptom | Likely cause |
|---------|-------------|
| Tab opens but stays on "Connecting to DICOM viewer…" forever | Popup blocker prevented the tab from opening properly; or `window.opener` is null; or the opener never received the ready signal |
| Tab shows "Open this page from the DICOM viewer." immediately | Tab was opened by typing the URL directly, not via the button |
| Progress bar never moves | `imageIds` array was not passed correctly; postMessage payload is empty |
| Tab shows "GPU not available" | Machine does not support WebGL2, or the GL context was already lost |
| Tab shows "Shader compilation failed" | GLSL syntax error; check the browser console for the shader log |

---

## 6. Summary Comparison Table

| Feature | Where | Correct output | Common failure |
|---------|-------|---------------|---------------|
| GPU volume upload | Invisible (no UI) | GPU buttons visible; no console errors | Buttons hidden; TEXTURE_3D error |
| GPU MPR axial | MPR tab (GPU mode) | Identical to CPU axial | All black (W/L not set); flipped (Y not inverted) |
| GPU MPR coronal | MPR tab (GPU mode) | Identical to CPU coronal | Black (origin/dx/dy wrong); squashed (no aspect ratio) |
| GPU MPR sagittal | MPR tab (GPU mode) | Identical to CPU sagittal | Black or wrong plane |
| 3D MIP | Vol tab | Skeletal projection, rotates with drag | All black or white (W/L mismatch) |
| 3D TF — Bone | Vol tab | Ivory skeleton, faint pink tissue | All black (TF range mismatch vs actual HU) |
| 3D TF — Soft Tissue | Vol tab | Pink organs, yellow fat | All black or faint smear |
| 3D TF — Lung | Vol tab | Cyan parenchyma, red vessels | All black or uniform colour |
| DRR AP | DRR tab | Chest-X-ray-like, bone dark, lung light | All white (scale too low); all black (scale too high) |
| DRR Lateral | DRR tab | Spine vertical band, ribs end-on | Geometry looks like AP (wrong basis vectors) |
| DRR rotation | DRR tab | Smooth rotation, centred patient | Static (mousemove not triggering render) |

---

## 7. Quick Checklist Before Reporting an Issue

1. **Open the browser DevTools console** (F12 → Console). Are there any red errors? If yes, note the exact message.
2. **Is the GPU button visible?** If not, check that the loaded series is CT or MR with more than 1 slice.
3. **Did the new tab open?** If the tab opens but stays loading, check for "popup blocked" messages.
4. **Does the progress bar reach 100%?** If it stalls, a slice failed to decode — look for network errors in the DevTools Network tab.
5. **Is it completely black?** Try the MIP mode in the 3D tab first (most robust). If MIP is black, the W/L settings from the main viewer may be extreme — try the Bone preset button.
6. **Is it completely white?** For DRR: slide the contrast slider to the right. For MIP: try a narrow preset like Soft Tissue.
7. **Are GPU and CPU outputs identical for MPR?** If not, note which plane differs and whether it is flipped, scaled wrong, or completely black.
