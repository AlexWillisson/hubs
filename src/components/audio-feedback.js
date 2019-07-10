// This computation is expensive, so we run on at most one avatar per frame, including quiet avatars.
// However if we detect an avatar is seen speaking (its volume is above DISABLE_AT_VOLUME_THRESHOLD)
// then we continue analysis for at least DISABLE_GRACE_PERIOD_MS and disable doing it every frame if
// the avatar is quiet during that entire duration (eg they are muted)
const DISABLE_AT_VOLUME_THRESHOLD = 0.00001;
const DISABLE_GRACE_PERIOD_MS = 10000;
const MIN_VOLUME_THRESHOLD = 0.01;

const getVolume = levels => {
  let sum = 0;
  for (let i = 0; i < levels.length; i++) {
    const amplitude = (levels[i] - 128) / 128;
    sum += amplitude * amplitude;
  }
  const currVolume = Math.sqrt(sum / levels.length);
  return currVolume < MIN_VOLUME_THRESHOLD ? 0 : currVolume;
};

const tempScaleFromPosition = new THREE.Vector3();
const tempScaleToPosition = new THREE.Vector3();

export function getAudioFeedbackScale(fromObject, toObject, minScale, maxScale, volume) {
  tempScaleToPosition.setFromMatrixPosition(toObject.matrixWorld);
  tempScaleFromPosition.setFromMatrixPosition(fromObject.matrixWorld);
  const distance = tempScaleFromPosition.distanceTo(tempScaleToPosition) / 10;
  return Math.min(maxScale, minScale + (maxScale - minScale) * volume * 8 * distance);
}

/**
 * Emits audioFrequencyChange events based on a networked audio source
 * @namespace avatar
 * @component networked-audio-analyser
 */
AFRAME.registerComponent("networked-audio-analyser", {
  async init() {
    this.volume = 0;
    this.prevVolume = 0;
    this.immediateVolume = 0;
    this.smoothing = 0.3;
    this._updateAnalysis = this._updateAnalysis.bind(this);
    this._runScheduledWork = this._runScheduledWork.bind(this);
    this.el.sceneEl.systems["frame-scheduler"].schedule(this._updateAnalysis, "audio-analyser");
    this.el.addEventListener("sound-source-set", event => {
      const ctx = THREE.AudioContext.getContext();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 32;
      this.levels = new Uint8Array(this.analyser.frequencyBinCount);
      event.detail.soundSource.connect(this.analyser);
    });
  },

  remove: function() {
    this.el.sceneEl.systems["frame-scheduler"].unschedule(this._runScheduledWork, "audio-analyser");
  },

  tick: function(t) {
    if (!this.avatarIsQuiet) {
      this._updateAnalysis(t);
    }
  },

  _runScheduledWork: function() {
    if (this.avatarIsQuiet) {
      this._updateAnalysis();
    }
  },

  // Updates the analysis/volume. If t is passed, that implies this is called via tick
  // and so as a performance optimization will check to see if it's been at least DISABLE_GRACE_PERIOD_MS
  // since the last volume was seen above DISABLE_AT_VOLUME_THRESHOLD, and if so, will disable
  // tick updates until the volume exceeds the level again.
  _updateAnalysis: function(t) {
    if (!this.analyser) return;

    // take care with compatibility, e.g. safari doesn't support getFloatTimeDomainData
    this.analyser.getByteTimeDomainData(this.levels);
    this.immediateVolume = getVolume(this.levels);
    this.volume = this.smoothing * this.immediateVolume + (1 - this.smoothing) * this.prevVolume;
    this.prevVolume = this.volume;

    if (this.volume < DISABLE_AT_VOLUME_THRESHOLD) {
      if (t && this.lastSeenVolume && this.lastSeenVolume < t - DISABLE_GRACE_PERIOD_MS) {
        this.avatarIsQuiet = true;
      }
    } else {
      if (t) {
        this.lastSeenVolume = t;
      }

      this.avatarIsQuiet = false;
    }
  }
});

/**
 * Performs local audio analysis, currently used to scale head when using video recording from camera.
 */
AFRAME.registerSystem("local-audio-analyser", {
  async init() {
    this.volume = 0;
    this.prevVolume = 0;
    this.smoothing = 0.3;
    this.immediateVolume = 0;
    this.subscribers = [];
  },

  subscribe(ii) {
    if (this.subscribers.indexOf(ii) === -1) {
      this.subscribers.push(ii);
    }
  },

  unsubscribe(ii) {
    const index = this.subscribers.indexOf(ii);
    if (index !== -1) {
      this.subscribers.splice(index, 1);
    }
  },

  tick: async function() {
    if (!NAF.connection.adapter) return;

    if (!this.subscribers.length) {
      this.stream = this.analyser = null;
    } else if (!this.stream) {
      this.stream = await NAF.connection.adapter.getMediaStream(NAF.clientId, "audio");
      if (!this.stream) return;

      const ctx = THREE.AudioContext.getContext();
      const source = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 32;
      this.levels = new Uint8Array(this.analyser.frequencyBinCount);
      source.connect(this.analyser);
    }

    if (!this.analyser || !this.stream) return;

    // take care with compatibility, e.g. safari doesn't support getFloatTimeDomainData
    this.analyser.getByteTimeDomainData(this.levels);
    this.immediateVolume = getVolume(this.levels);
    this.volume = this.smoothing * this.immediateVolume + (1 - this.smoothing) * this.prevVolume;
    this.prevVolume = this.volume;
  }
});

/**
 * Sets an entity's scale base on audioFrequencyChange events.
 * @namespace avatar
 * @component scale-audio-feedback
 */
AFRAME.registerComponent("scale-audio-feedback", {
  schema: {
    minScale: { default: 1 },
    maxScale: { default: 2 }
  },

  init() {
    this._playerCamera = document.getElementById("player-camera").object3D;
  },

  tick() {
    // TODO: come up with a cleaner way to handle this.
    // bone's are "hidden" by scaling them with bone-visibility, without this we would overwrite that.
    if (!this.el.object3D.visible) return;

    const { minScale, maxScale } = this.data;

    const audioAnalyser = this.el.components["networked-audio-analyser"];

    if (!audioAnalyser) return;

    const { object3D } = this.el;

    const scale = getAudioFeedbackScale(this.el.object3D, this._playerCamera, minScale, maxScale, audioAnalyser.volume);

    object3D.scale.setScalar(scale);
    object3D.matrixNeedsUpdate = true;
  }
});

const micLevels = [
  "mic-level-1.png",
  "mic-level-1.png",
  "mic-level-2.png",
  "mic-level-3.png",
  "mic-level-4.png",
  "mic-level-5.png",
  "mic-level-7.png",
  "mic-level-7.png"
];
AFRAME.registerComponent("mic-button", {
  init() {
    this.loudest = 0;
    this.prevImage = "";
    this.decayingVolume = 0;
    this.smoothing = 0.8;
  },
  tick() {
    const audioAnalyser = this.el.sceneEl.systems["local-audio-analyser"];
    if (!audioAnalyser) return;

    if (this.el.object3D.visible) {
      audioAnalyser.subscribe(this);
    } else {
      audioAnalyser.unsubscribe(this);
    }
    let volume;
    if (audioAnalyser.immediateVolume > this.decayingVolume) {
      this.decayingVolume = audioAnalyser.immediateVolume;
      volume = audioAnalyser.immediateVolume;
      if (this.loudest < volume) {
        console.log(volume);
      }
      this.loudest = Math.max(this.loudest, volume);
    } else {
      volume = this.decayingVolume * this.smoothing < 0.001 ? 0 : this.decayingVolume * this.smoothing;
      this.decayingVolume = volume;
    }
    const level =
      volume < this.loudest * 0.1
        ? 1
        : volume < this.loudest * 0.2
          ? 2
          : volume < this.loudest * 0.45
            ? 3
            : volume < this.loudest * 0.6
              ? 4
              : volume < this.loudest * 0.8
                ? 5
                : 7;
    const newimage = micLevels[level];
    if (newimage !== this.prevImage) {
      this.prevImage = newimage;
      this.el.setAttribute("icon-button", { image: this.prevImage });
    }
  }
});
