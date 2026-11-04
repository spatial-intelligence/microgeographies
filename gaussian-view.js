import * as THREE from "three";

// Anisotropic Gaussian ellipses from DA3's actual means, scales, rotations
// and opacities. Back-to-front alpha blending; DC spherical harmonic colour.
export function createGaussianLayer(data) {
  const count = data.means.length, geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0], 3));
  geometry.setIndex([0,1,2, 0,2,3]); geometry.instanceCount = count;
  const fields = {mean: [data.means, 3], scale: [data.scales, 3], rotation: [data.rotations, 4],
    tint: [data.colors, 3], alpha: [data.opacities.map(a => [a]), 1]};
  for (const [name, [, size]] of Object.entries(fields)) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(count*size), size));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    uniforms: {viewport: {value: new THREE.Vector2(1,1)}, brightness: {value: 1}, sizeMultiplier: {value: 1},
      colorMode: {value: 0}, heightAxis: {value:new THREE.Vector3(0,-1,0)}, scalarRange: {value:new THREE.Vector2(0,1)}},
    vertexShader: `
      attribute vec3 mean, scale, tint;
      attribute vec4 rotation;
      attribute float alpha;
      uniform vec2 viewport;
      uniform float sizeMultiplier;
      uniform float colorMode;
      uniform vec3 heightAxis;
      uniform vec2 scalarRange;
      varying vec2 gaussianUV;
      varying vec3 gaussianColor;
      varying float gaussianAlpha;
      void main() {
        vec4 center = modelViewMatrix * vec4(mean, 1.0);
        vec4 clip = projectionMatrix * center;
        gaussianUV = position.xy * 3.0;
        gaussianColor = tint; gaussianAlpha = alpha;
        if(colorMode>0.5) {
          float scalar = colorMode<1.5 ? dot(mean,heightAxis) : distance(mean,cameraPosition);
          float t=clamp((scalar-scalarRange.x)/max(scalarRange.y-scalarRange.x,0.000001),0.,1.);
          float hue=(colorMode<1.5 ? 1.-t : t)*0.66;
          vec3 p=abs(fract(vec3(hue)+vec3(0.,2./3.,1./3.))*6.-3.);
          gaussianColor=mix(vec3(1.),clamp(p-1.,0.,1.),0.8)*0.9;
        }
        if (center.z >= -0.001) { gl_Position = vec4(2.,2.,2.,1.); return; }
        vec4 q = normalize(rotation); // DA3 order wxyz
        float w=q.x, x=q.y, y=q.z, z=q.w;
        mat3 r = mat3(1.-2.*(y*y+z*z),2.*(x*y+w*z),2.*(x*z-w*y),
          2.*(x*y-w*z),1.-2.*(x*x+z*z),2.*(y*z+w*x),
          2.*(x*z+w*y),2.*(y*z-w*x),1.-2.*(x*x+y*y));
        mat3 axes = mat3(modelViewMatrix) * r * mat3(scale.x,0.,0.,0.,scale.y,0.,0.,0.,scale.z) * sizeMultiplier;
        float focal = viewport.y * projectionMatrix[1][1] * 0.5;
        float depth = -center.z;
        vec3 jx = vec3(focal/depth, 0., focal*center.x/(depth*depth));
        vec3 jy = vec3(0., focal/depth, focal*center.y/(depth*depth));
        vec3 ax = vec3(dot(jx,axes[0]),dot(jx,axes[1]),dot(jx,axes[2]));
        vec3 ay = vec3(dot(jy,axes[0]),dot(jy,axes[1]),dot(jy,axes[2]));
        float a=dot(ax,ax)+0.3, b=dot(ax,ay), c=dot(ay,ay)+0.3;
        float mid=(a+c)*0.5, rad=length(vec2((a-c)*0.5,b));
        vec2 major = abs(b)>0.00001 ? normalize(vec2(b,mid+rad-a)) : (a>=c ? vec2(1.,0.) : vec2(0.,1.));
        vec2 minor = vec2(-major.y,major.x);
        vec2 offset = gaussianUV.x*sqrt(max(mid+rad,0.1))*major + gaussianUV.y*sqrt(max(mid-rad,0.1))*minor;
        clip.xy += offset * 2.0 / viewport * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: `
      uniform float brightness;
      varying vec2 gaussianUV;
      varying vec3 gaussianColor;
      varying float gaussianAlpha;
      void main() {
        float power = dot(gaussianUV,gaussianUV);
        if (power>9.0) discard;
        float opacity = min(0.99,gaussianAlpha*exp(-0.5*power));
        if (opacity<0.0039) discard;
        gl_FragColor = vec4(gaussianColor*brightness,opacity);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false;
  let last = "";
  const indices = Array.from({length: count}, (_,i) => i), depths = new Float32Array(count);
  function update(camera, height) {
    material.uniforms.viewport.value.set(height*camera.aspect, height);
    if (!mesh.visible) return;
    camera.updateMatrixWorld();
    const matrix = camera.matrixWorldInverse.elements;
    const signature = matrix.map(v=>v.toFixed(5)).join(",");
    if (signature === last) return;
    last = signature;
    if(material.uniforms.colorMode.value===2) {
      let min=Infinity,max=-Infinity;
      for(const p of data.means) {const d=Math.hypot(p[0]-camera.position.x,p[1]-camera.position.y,p[2]-camera.position.z);min=Math.min(min,d);max=Math.max(max,d);}
      material.uniforms.scalarRange.value.set(min,max);
    }
    for (let i=0;i<count;i++) { const p=data.means[i]; depths[i]=matrix[2]*p[0]+matrix[6]*p[1]+matrix[10]*p[2]+matrix[14]; }
    indices.sort((a,b)=>depths[a]-depths[b]);
    for (const [name,[source,size]] of Object.entries(fields)) {
      const attr=geometry.attributes[name];
      for (let i=0;i<count;i++) for (let k=0;k<size;k++) attr.array[i*size+k]=source[indices[i]][k];
      attr.needsUpdate=true;
    }
  }
  return {mesh, update, setBrightness(value) {material.uniforms.brightness.value=value;},
    setSize(value) {material.uniforms.sizeMultiplier.value=value;},
    setColorMode(mode,axis) {
      const code=mode==="height" ? 1 : mode==="distance" ? 2 : 0;
      const oldAxis=material.uniforms.heightAxis.value;
      if(material.uniforms.colorMode.value===code && oldAxis.x===axis[0] && oldAxis.y===axis[1] && oldAxis.z===axis[2]) return;
      material.uniforms.colorMode.value=code;
      material.uniforms.heightAxis.value.fromArray(axis);
      if(mode==="height") {
        let min=Infinity,max=-Infinity;
        for(const p of data.means) {const h=p[0]*axis[0]+p[1]*axis[1]+p[2]*axis[2];min=Math.min(min,h);max=Math.max(max,h);}
        material.uniforms.scalarRange.value.set(min,max);
      }
      last="";
    },
    dispose() {geometry.dispose();material.dispose();}};
}
