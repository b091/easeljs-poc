import {EaselJS} from 'EaselJS';
import {Pages} from './Pages';

export class Main {

    pictures;
    canvas;
    stage;
    imageCount;
    animate;
    halfCanvasWidth;
    halfCanvasWidthByTen;

    constructor() {

        this.canvas = document.getElementById('demoCanvas');
        this.canvas.onmousemove = this.onMouseMove.bind(this);
        this.stage = new createjs.Stage(this.canvas);

        this.pictures = new Array(6);
        this.imageCount = 0;
        this.animate = false;
        this.halfCanvasWidth = this.canvas.width / 2;
        this.halfCanvasWidthByTen = this.halfCanvasWidth / 10;

        this.loadPages();


        this.stage.enableMouseOver(20);
        createjs.Ticker.setFPS(60);
        createjs.Ticker.addEventListener("tick", this.onTick.bind(this));

        document.addEventListener("click", () => {
            this.animate = !this.animate;
        });
        window.stage = this.stage;
    }

    loadPages() {
        for (let i = 0; i < this.pictures.length; i++) {
            this.pictures[i] = new Image();
            this.pictures[i].src = "img/page_" + (i + 1) + ".png";
            this.pictures[i].onload = this.onImageLoad.bind(this);
        }
    }

    onImageLoad() {
        this.imageCount++;
        if (this.imageCount >= this.pictures.length) {
            Pages.createPages(this.pictures);
            this.stage.update();
        }
    }

    onTick() {
        if (this.animate === false) {
            return;
        }
        let direction = (this.stage.mouseX - this.halfCanvasWidth) / this.halfCanvasWidthByTen;
        for (let i = 0; i < this.pictures.length; i++) {
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