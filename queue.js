class Queue {
  constructor() {
    this.songs = [];
    this.playing = false;
  }

  add(song) {
    this.songs.push(song);
  }

  next() {
    return this.songs.shift();
  }

  isEmpty() {
    return this.songs.length === 0;
  }

  // Fisher-Yates shuffle
  shuffle() {
    for (let i = this.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.songs[i], this.songs[j]] = [this.songs[j], this.songs[i]];
    }
  }

  clear() {
    this.songs = [];
  }
}

module.exports = Queue;
