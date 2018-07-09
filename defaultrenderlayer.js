import BufferManagerTransparencyOnly from './buffermanagertransparencyonly.js'
import BufferManagerPerColor from './buffermanagerpercolor.js'
import BufferTransformer from './buffertransformer.js'
import Utils from './utils.js'
import VertexQuantization from './vertexquantization.js'
import RenderLayer from './renderlayer.js'

/*
 * This is the default renderer for what we called the base layer. Usually this layer should be small enough to be rendered at good FPS
 * 
 * This class does:
 * - Populate the CPU side buffers
 * - Allocate buffers on the GPU and flush buffers to it
 * - Render all buffers
 * 
 */

export default class DefaultRenderLayer extends RenderLayer {
	constructor(viewer) {
		super(viewer);
		
		if (this.settings.useObjectColors) {
			this.bufferManager = new BufferManagerPerColor(this.settings, this, this.viewer.bufferSetPool);
		} else {
			this.bufferManager = new BufferManagerTransparencyOnly(this.settings, this, this.viewer.bufferSetPool);
		}

		this.bufferTransformer = new BufferTransformer(settings, viewer.vertexQuantization);

		this.liveBuffers = [];
		this.liveReusedBuffers = [];
	}

	createObject(loaderId, roid, oid, objectId, geometryIds, matrix, scaleMatrix, hasTransparency, type) {
		var object = {
				id: objectId,
				visible: type != "IfcOpeningElement" && type != "IfcSpace",
				hasTransparency: hasTransparency,
				matrix: matrix,
				scaleMatrix: scaleMatrix,
				geometry: [],
				roid: roid,
//				object: this.viewer.model.objects[oid],
				add: (geometryId, objectId) => {
					this.addGeometryToObject(geometryId, objectId, loader);
				}
		};

		var loader = this.getLoader(loaderId);
		loader.objects[oid] = object;

		geometryIds.forEach((id) => {
			this.addGeometryToObject(id, object.id, loader);
		});

		this.viewer.stats.inc("Models", "Objects");

		return object;
	}
	
	addGeometryToObject(geometryId, objectId, loader) {
		var geometry = loader.geometries[geometryId];
		if (geometry == null) {
			return;
		}
		var object = loader.objects[objectId];
		if (object.visible) {
			this.addGeometry(loader.loaderId, geometry, object);
			object.geometry.push(geometryId);
		} else {
			this.viewer.stats.inc("Primitives", "Nr primitives hidden", geometry.indices.length / 3);
			if (this.progressListener != null) {
				this.progressListener(this.viewer.stats.get("Primitives", "Nr primitives loaded") + this.viewer.stats.get("Primitives", "Nr primitives hidden"));
			}
		}
		if (geometry.isReused) {
			geometry.reuseMaterialized++;
			if (geometry.reuseMaterialized == geometry.reused) {
				this.addGeometryReusable(geometry, loader);
			}
		}
	}

	addGeometryReusable(geometry, loader) {
		const positionBuffer = this.gl.createBuffer();
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
		this.gl.bufferData(this.gl.ARRAY_BUFFER, this.bufferTransformer.convertVertices(loader.roid, geometry.positions), this.gl.STATIC_DRAW, 0, 0);
		
		const normalBuffer = this.gl.createBuffer();
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
		this.gl.bufferData(this.gl.ARRAY_BUFFER, this.bufferTransformer.convertNormals(geometry.normals), this.gl.STATIC_DRAW, 0, 0);
		
		if (geometry.colors != null) {
			var colorBuffer = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
			this.gl.bufferData(this.gl.ARRAY_BUFFER, geometry.colors, this.gl.STATIC_DRAW, 0, 0);
		}

		const indexBuffer = this.gl.createBuffer();
		this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
		var indices = this.bufferTransformer.convertIndices(geometry.indices, geometry.positions.length);
		this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, indices, this.gl.STATIC_DRAW, 0, 0);

		const instancesBuffer = this.gl.createBuffer();
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, instancesBuffer);
		var matrices = new Float32Array(geometry.matrices.length * 16);
		geometry.matrices.forEach((matrix, index) => {
			matrices.set(matrix, index * 16);
		});
		this.gl.bufferData(this.gl.ARRAY_BUFFER, matrices, this.gl.STATIC_DRAW, 0, 0);

		var vao = this.gl.createVertexArray();
		this.gl.bindVertexArray(vao);
		
		var programInfo = this.viewer.programManager.getProgram({
			instancing: true,
			useObjectColors: this.settings.useObjectColors,
			quantizeNormals: this.settings.quantizeNormals,
			quantizeVertices: this.settings.quantizeVertices
		});

		{
			const numComponents = 3;
			const normalize = false;
			const stride = 0;
			const offset = 0;
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
			
			if (this.settings.quantizeVertices) {
				this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexPosition, numComponents, this.gl.SHORT, normalize, stride, offset);
			} else {
				this.gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition,	numComponents, this.gl.FLOAT, normalize, stride, offset);
			}
			this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
		}
		{
			const numComponents = 3;
			const normalize = false;
			const stride = 0;
			const offset = 0;
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
			
			if (this.settings.quantizeNormals) {
				this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.BYTE, normalize, stride, offset);
			} else {
				this.gl.vertexAttribPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.FLOAT, normalize, stride, offset);
			}
			this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexNormal);
		}

		if (!this.settings.useObjectColors) {
			const numComponents = 4;
			const type = this.gl.FLOAT;
			const normalize = false;
			const stride = 0;
			const offset = 0;
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
			this.gl.vertexAttribPointer(programInfo.attribLocations.vertexColor, numComponents, type, normalize, stride, offset);
			this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexColor);
		}

		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, instancesBuffer);

		this.gl.enableVertexAttribArray(programInfo.attribLocations.instances);
		this.gl.vertexAttribPointer(programInfo.attribLocations.instances + 0, 4, this.gl.FLOAT, false, 64, 0);

		this.gl.enableVertexAttribArray(programInfo.attribLocations.instances + 1);
		this.gl.vertexAttribPointer(programInfo.attribLocations.instances + 1, 4, this.gl.FLOAT, false, 64, 16);

		this.gl.enableVertexAttribArray(programInfo.attribLocations.instances + 2);
		this.gl.vertexAttribPointer(programInfo.attribLocations.instances + 2, 4, this.gl.FLOAT, false, 64, 32);

		this.gl.enableVertexAttribArray(programInfo.attribLocations.instances + 3);
		this.gl.vertexAttribPointer(programInfo.attribLocations.instances + 3, 4, this.gl.FLOAT, false, 64, 48);

		this.gl.vertexAttribDivisor(programInfo.attribLocations.instances + 0, 1);
		this.gl.vertexAttribDivisor(programInfo.attribLocations.instances + 1, 1);
		this.gl.vertexAttribDivisor(programInfo.attribLocations.instances + 2, 1);
		this.gl.vertexAttribDivisor(programInfo.attribLocations.instances + 3, 1);

		this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);		  

		this.gl.bindVertexArray(null);

		var buffer = {
				positionBuffer: positionBuffer,
				normalBuffer: normalBuffer,
				indexBuffer: indexBuffer,
				nrIndices: geometry.indices.length,
				vao: vao,
//				matrices: geometry.matrices,
//				dirtyMatrices: false,
				nrProcessedMatrices: geometry.matrices.length,
//				geometry: geometry,
				instancesBuffer: instancesBuffer,
				roid: geometry.roid,
//				instances: matrices,
				hasTransparency: geometry.hasTransparency,
				indexType: indices instanceof Uint16Array ? this.gl.UNSIGNED_SHORT : this.gl.UNSIGNED_INT
		};
		
		if (this.settings.useObjectColors) {
			buffer.colorBuffer = colorBuffer;
			buffer.color = [geometry.color.r, geometry.color.g, geometry.color.b, geometry.color.a];
			buffer.colorHash = Utils.hash(JSON.stringify(buffer.color));
		}
		
		delete loader.geometries[geometry.id];
		this.liveReusedBuffers.push(buffer);

		this.viewer.stats.inc("Primitives", "Nr primitives loaded", (buffer.nrIndices / 3) * geometry.matrices.length);
		if (this.progressListener != null) {
			this.progressListener(this.viewer.stats.get("Primitives", "Nr primitives loaded") + this.viewer.stats.get("Primitives", "Nr primitives hidden"));
		}

		var toadd = geometry.bytes + geometry.matrices.length * 16 * 4;
		this.viewer.stats.inc("Drawing", "Draw calls per frame");
		this.viewer.stats.inc("Data", "GPU bytes reuse", toadd);
		this.viewer.stats.inc("Data", "GPU bytes total", toadd);

		geometry.buffer = buffer;
	}

	addGeometry(loaderId, geometry, object) {
		if (this.settings.reuseFn(geometry.reused, geometry)) {
			geometry.matrices.push(object.matrix);
			
			this.viewer.stats.inc("Drawing", "Triangles to draw", geometry.indices.length / 3);

			return;
		}

		var sizes = {
			vertices: geometry.positions.length,
			normals: geometry.normals.length,
			indices: geometry.indices.length,
			colors: (geometry.colors != null ? geometry.colors.length : 0)
		};
		var buffer = this.bufferManager.getBufferSet(geometry.hasTransparency, geometry.color, sizes);

		super.addGeometry(loaderId, geometry, object, buffer, sizes);
	}
	
	done(loaderId) {
		var loader = this.getLoader(loaderId);

		Object.keys(loader.geometries).forEach((key, index) => {
			var geometry = loader.geometries[key];
			if (geometry.isReused) {
				this.addGeometryReusable(geometry, loader);
			}
		});
		
		Object.keys(loader.objects).forEach((key, index) => {
			var object = loader.objects[key];
			object.add = null;
		});

		this.removeLoader(loaderId);
	}
	
	completelyDone() {
		this.flushAllBuffers();
		
		if (this.settings.useObjectColors) {
			// When using object colors, it makes sense to sort the buffers by color, so we can potentially skip a few uniform binds
			// It might be beneficiary to do this sorting on-the-lfy and not just when everything is loaded
			this.sortBuffers(this.liveBuffers);
			this.sortBuffers(this.liveReusedBuffers);
		}
		
		this.bufferManager.clear();
	}
	
	flushAllBuffers() {
		for (var buffer of this.bufferManager.getAllBuffers()) {
			this.flushBuffer(buffer);
		}
	}
	
	flushBuffer(buffer) {
		if (buffer == null) {
			return;
		}
		if (buffer.nrIndices == 0) {
			return;
		}
		
		this.viewer.stats.inc("Buffers", "Flushed buffers");
		
		var programInfo = this.viewer.programManager.getProgram({
			instancing: false,
			useObjectColors: buffer.colors == null,
			quantizeNormals: this.settings.quantizeNormals,
			quantizeVertices: this.settings.quantizeVertices
		});
		
		if (!this.settings.fakeLoading) {
			const positionBuffer = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
			this.gl.bufferData(this.gl.ARRAY_BUFFER, buffer.positions, this.gl.STATIC_DRAW, 0, buffer.positionsIndex);

			const normalBuffer = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
			this.gl.bufferData(this.gl.ARRAY_BUFFER, buffer.normals, this.gl.STATIC_DRAW, 0, buffer.normalsIndex);

			if (buffer.colors != null) {
				var colorBuffer = this.gl.createBuffer();
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
				this.gl.bufferData(this.gl.ARRAY_BUFFER, buffer.colors, this.gl.STATIC_DRAW, 0, buffer.colorsIndex);
			}

			const indexBuffer = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
			this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, buffer.indices, this.gl.STATIC_DRAW, 0, buffer.indicesIndex);

			var vao = this.gl.createVertexArray();
			this.gl.bindVertexArray(vao);

			{
				const numComponents = 3;
				const normalize = false;
				const stride = 0;
				const offset = 0;
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
				if (this.settings.quantizeVertices) {
					this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexPosition, numComponents, this.gl.SHORT, normalize, stride, offset);
				} else {
					this.gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition, numComponents, this.gl.FLOAT, normalize, stride, offset);
				}
				this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
			}
			{
				const numComponents = 3;
				const normalize = false;
				const stride = 0;
				const offset = 0;
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
				if (this.settings.quantizeNormals) {
					this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.BYTE, normalize, stride, offset);
				} else {
					this.gl.vertexAttribPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.FLOAT, normalize, stride, offset);
				}
				this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexNormal);
			}
			
			if (buffer.colors != null) {
				const numComponents = 4;
				const type = this.gl.FLOAT;
				const normalize = false;
				const stride = 0;
				const offset = 0;
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
				this.gl.vertexAttribPointer(programInfo.attribLocations.vertexColor, numComponents,	type, normalize, stride, offset);
				this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexColor);
			}

			this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

			this.gl.bindVertexArray(null);

			var newBuffer = {
				positionBuffer: positionBuffer,
				normalBuffer: normalBuffer,
				indexBuffer: indexBuffer,
				nrIndices: buffer.nrIndices,
				vao: vao,
				hasTransparency: buffer.hasTransparency
			};
			
			if (buffer.colors != null) {
				newBuffer.colorBuffer = colorBuffer;
			}
			
			if (this.settings.useObjectColors) {
				newBuffer.color = [buffer.color.r, buffer.color.g, buffer.color.b, buffer.color.a];
				newBuffer.colorHash = Utils.hash(JSON.stringify(buffer.color));
			}
			
			this.liveBuffers.push(newBuffer);
			this.viewer.dirty = true;
		}

		var toadd = buffer.positionsIndex * (this.settings.quantizeVertices ? 2 : 4) + buffer.normalsIndex * (this.settings.quantizeNormals ? 1 : 4) + (buffer.colorsIndex != null ? buffer.colorsIndex * 4 : 0) + buffer.indicesIndex * 4;

		this.viewer.stats.inc("Primitives", "Nr primitives loaded", buffer.nrIndices / 3);
		if (this.progressListener != null) {
			this.progressListener(this.viewer.stats.get("Primitives", "Nr primitives loaded") + this.viewer.stats.get("Primitives", "Nr primitives hidden"));
		}
		this.viewer.stats.inc("Data", "GPU bytes", toadd);
		this.viewer.stats.inc("Drawing", "Draw calls per frame");
		this.viewer.stats.inc("Data", "GPU bytes total", toadd);
		this.viewer.stats.inc("Buffers", "Buffer groups");
		this.viewer.stats.inc("Drawing", "Triangles to draw", buffer.nrIndices / 3);

		this.bufferManager.resetBuffer(buffer);
	}

	renderBuffer(buffer, programInfo) {
		this.gl.bindVertexArray(buffer.vao);

		this.gl.drawElements(this.gl.TRIANGLES, buffer.nrIndices, this.gl.UNSIGNED_INT, 0);

		this.gl.bindVertexArray(null);
	}

	renderReusedBuffer(buffer, programInfo) {
		this.gl.bindVertexArray(buffer.vao);
		
		if (this.settings.quantizeVertices) {
			this.gl.uniformMatrix4fv(programInfo.uniformLocations.vertexQuantizationMatrix, false, this.viewer.vertexQuantization.getUntransformedInverseVertexQuantizationMatrixForRoid(buffer.roid));
		}
		this.gl.drawElementsInstanced(this.gl.TRIANGLES, buffer.nrIndices, buffer.indexType, 0, buffer.nrProcessedMatrices);

		this.gl.bindVertexArray(null);
	}

	render(transparency) {
		this.renderBuffers(transparency, this.liveBuffers, false);
		this.renderBuffers(transparency, this.liveReusedBuffers, true);
	}
	
	renderBuffers(transparency, buffers, reuse) {
		if (buffers.length > 0) {
			var programInfo = this.viewer.programManager.getProgram({
				instancing: reuse,
				useObjectColors: this.settings.useObjectColors,
				quantizeNormals: this.settings.quantizeNormals,
				quantizeVertices: this.settings.quantizeVertices
			});
			this.gl.useProgram(programInfo.program);
			// TODO find out whether it's possible to do this binding before the program is used (possibly just once per frame, and better yet, a different location in the code)
			this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, programInfo.uniformBlocks.LightData, this.viewer.lighting.lightingBuffer);
			
			this.gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, this.viewer.camera.projMatrix);
			this.gl.uniformMatrix4fv(programInfo.uniformLocations.normalMatrix, false, this.viewer.camera.normalMatrix);
			this.gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, this.viewer.camera.viewMatrix);
			if (this.settings.quantizeVertices) {
				if (!reuse) {
					this.gl.uniformMatrix4fv(programInfo.uniformLocations.vertexQuantizationMatrix, false, this.viewer.vertexQuantization.getTransformedInverseVertexQuantizationMatrix());
				}
			}
	
			var lastUsedColorHash = null;
			
			for (let buffer of buffers) {
				if (buffer.hasTransparency == transparency) {
					if (this.settings.useObjectColors) {
						if (lastUsedColorHash == null || lastUsedColorHash != buffer.colorHash) {
							this.gl.uniform4fv(programInfo.uniformLocations.vertexColor, buffer.color);
							lastUsedColorHash = buffer.colorHash;
						}
					}
					if (reuse) {
						this.renderReusedBuffer(buffer, programInfo);
					} else {
						this.renderBuffer(buffer, programInfo);
					}
				}
			}
		}
	}
	
	setProgressListener(progressListener) {
		this.progressListener = progressListener;
	}
}