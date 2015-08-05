import Stats from 'statsjs';

export class Statistics {

    statsjs;

    constructor() {
        this.statsjs = new Stats();

        this.statsjs.domElement.style.cssText = 'position:fixed;left:0;top:0;z-index:10000';

        document.body.appendChild(this.statsjs.domElement);

        requestAnimationFrame(this.updateStats.bind(this));
    }

    updateStats() {
        this.statsjs.update();
        requestAnimationFrame(this.updateStats.bind(this))
    }
}

