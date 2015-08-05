import {EaselJS} from 'EaselJS';
import {TweenJS} from 'TweenJS';
import {Pages} from './Pages';
import * as Hammer from 'hammer';
import {Statistics} from './Statistics'

export class Main {

    pages;
    canvas;
    stage;
    pagesCount;
    globalContainer;

    constructor(canvas) {

        new Statistics();

        this.pages = new Array(6);
        this.pagesCount = 0;

        this.canvas = canvas;
        this.canvas.onmousemove = this.onMouseMove.bind(this);

        this.stage = new createjs.Stage(this.canvas);
        window.stage = this.stage;

        this.globalContainer = new createjs.Container();
        this.globalContainer.x = 0;
        this.globalContainer.y = 0;
        this.globalContainer.orgX = this.globalContainer.x;

        createjs.Touch.enable(this.stage);
        createjs.Ticker.timingMode = createjs.Ticker.RAF;
        createjs.Ticker.setFPS(30);
        createjs.Ticker.addEventListener("tick", this.stage);

        this.initHammer();
        this.loadPages();
    }

    initHammer() {
        var mc = new Hammer.default.Manager(this.canvas, {
            recognizers: [
                [Hammer.default.Swipe], [Hammer.default.Tap], [Hammer.default.Pan], [Hammer.default.Pinch]
            ]
        });

        mc.on('swipe', this.onSwipe.bind(this));
        mc.on('pan', this.onPan.bind(this));
        mc.on('panend', this.onPanEnd.bind(this));
        mc.on('tap', this.onTap.bind(this));
    }

    loadPages() {
        for (let i = 0; i < this.pages.length; i++) {
            this.pages[i] = new Image();
            this.pages[i].src = "img/page_" + (i + 1) + ".png";
            this.pages[i].onload = this.onImageLoad.bind(this);
        }
    }

    onImageLoad() {
        this.pagesCount++;
        if (this.pagesCount >= this.pages.length) {
            let elementsLoaded = 0;
            let pages = Pages.createPages(this.pages, () => {
                elementsLoaded++;
                if (elementsLoaded === 306) {
                    for (let i = 0; i < pages.length; i++) {
                        pages[i].cache(0, 0, 1862, 1862);
                        this.globalContainer.addChild(pages[i]);
                    }
                    stage.addChild(this.globalContainer);
                    stage.update();
                }
            });

        }
    }

    onPanEnd(ev) {
        this.globalContainer.orgX = this.globalContainer.x;
    }

    onPan(ev) {
        let x = this.globalContainer.orgX + ev.deltaX;
        createjs.Tween.get(this.globalContainer).to({x: x});
    }

    onSwipe(ev) {
    }

    onTap(ev) {
    }

    onClick(ev) {
    }

    onMouseMove(e) {
        if (!e) {
            e = window.event;
        }
        this.stage.mouseX = e.pageX - this.canvas.offsetLeft;
        this.stage.mouseY = e.pageY - this.canvas.offsetTop;
    }

}


export function initCanvas() {
    var canvasElement = document.getElementById('demoCanvas');
    canvasElement.width = window.innerWidth * window.devicePixelRatio;
    canvasElement.height = window.innerHeight * window.devicePixelRatio;
    canvasElement.style.width = window.innerWidth;
    canvasElement.style.height = window.innerHeight;
    return canvasElement;
}