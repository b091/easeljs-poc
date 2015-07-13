import {EaselJS} from 'EaselJS';
import {Pages} from './Pages';

export class Main {

    pages;
    canvas;
    stage;
    pagesCount;
    animate;
    halfCanvasWidth;
    halfCanvasWidthByTen;

    constructor() {

        this.canvas = document.getElementById('demoCanvas');
        this.canvas.onmousemove = this.onMouseMove.bind(this);
        this.stage = new createjs.Stage(this.canvas);

        this.pages = new Array(6);
        this.pagesCount = 0;
        this.animate = false;
        this.halfCanvasWidth = this.canvas.width / 2;
        this.halfCanvasWidthByTen = this.halfCanvasWidth / 10;

        this.stage.enableMouseOver(20);

        createjs.Ticker.timingMode = createjs.Ticker.RAF;
        //createjs.Ticker.timingMode = createjs.Ticker.RAF_SYNCHED;
        //createjs.Ticker.setFPS(30);

        createjs.Ticker.addEventListener("tick", this.onTick.bind(this));

        document.addEventListener("click", () => {
            this.animate = !this.animate;
        });
        window.stage = this.stage;

        this.loadPages();
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
            Pages.createPages(this.pages);

        }
    }

    onTick() {
        if (this.animate === false) {
            return;
        }
        let direction = (this.stage.mouseX - this.halfCanvasWidth) / this.halfCanvasWidthByTen;
        for (let i = 0; i < this.pages.length; i++) {
            if (this.stage.children[i]) {
                this.stage.children[i].x = this.stage.children[i].x - direction; // - pictures[i].width;
            }
        }
        this.stage.update();
    }

    onMouseMove(e) {
        if (!e) {
            e = window.event;
        }
        this.stage.mouseX = e.pageX - this.canvas.offsetLeft;
        this.stage.mouseY = e.pageY - this.canvas.offsetTop;
    }

}